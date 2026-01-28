import { z } from 'zod';
import { openrouterChat } from './llm/openrouter';

export type LlmMode = 'off' | 'rewrite' | 'full' | 'mock';

type LlmProvider = 'openrouter' | 'groq';

type LlmConfig = {
  mode: LlmMode;
  provider: LlmProvider;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
};

function readLlmConfig(): LlmConfig {
  const modeRaw = String(process.env.LLM_MODE ?? 'off').toLowerCase();
  let mode: LlmMode = modeRaw === 'rewrite' ? 'rewrite' : modeRaw === 'full' ? 'full' : modeRaw === 'mock' ? 'mock' : 'off';

  // Este módulo NÃO deve consumir Groq: Groq fica reservado ao chat de conversação.
  const provider: LlmProvider = 'openrouter';

  // Proteção: em produção, `mock` é quase sempre erro de configuração.
  // Faz override para `full` para evitar um "assistente" estático.
  const nodeEnv = String(process.env.NODE_ENV ?? '').toLowerCase();
  if (nodeEnv === 'production' && mode === 'mock') {
    mode = 'full';
  }

  const apiKey = String(process.env.OPENROUTER_API_KEY ?? '').trim();
  const modelDefault = 'arcee-ai/trinity-mini:free';
  const model = String(process.env.OPENROUTER_MODEL ?? modelDefault).trim();

  const timeoutRaw = process.env.OPENROUTER_TIMEOUT_MS;
  const timeoutMs = Math.max(1500, Math.min(20000, Number(timeoutRaw ?? 7000) || 7000));

  return { mode, provider, apiKey: apiKey ? apiKey : null, model: model || modelDefault, timeoutMs };
}

export function isLlmGenerationEnabled(): boolean {
  const cfg = readLlmConfig();
  return cfg.mode === 'full' || cfg.mode === 'mock';
}

export function getLlmStatus(): {
  mode: LlmMode;
  provider: LlmProvider;
  hasApiKey: boolean;
  model: string;
  timeoutMs: number;
  nodeEnv: string;
} {
  const cfg = readLlmConfig();
  return {
    mode: cfg.mode,
    provider: cfg.provider,
    hasApiKey: Boolean(cfg.apiKey),
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    nodeEnv: String(process.env.NODE_ENV ?? '')
  };
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      const id = setTimeout(() => reject(new Error('LLM_TIMEOUT')), timeoutMs);
      // evita que o timer segure o event loop
      (id as any).unref?.();
    })
  ]);
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function extractAssistantText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).text === 'string') {
      parts.push((item as any).text);
    }
  }
  const joined = parts.join('').trim();
  return joined ? joined : null;
}

function stripJsonCodeFences(s: string): string {
  const t = s.trim();
  if (!t.startsWith('```')) return t;
  // suporta ```json ... ``` ou ``` ... ```
  const lines = t.split(/\r?\n/);
  if (lines.length >= 2 && lines[0].startsWith('```')) {
    const body = lines.slice(1).join('\n');
    const endIdx = body.lastIndexOf('```');
    const inner = endIdx >= 0 ? body.slice(0, endIdx) : body;
    return inner.trim();
  }
  return t;
}

function safeParseJsonLenient(raw: string): unknown | null {
  const cleaned = stripJsonCodeFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    // tenta extrair o primeiro bloco {...}
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function chatCompletion(messages: ChatMessage[], opts?: { expectJson?: boolean }): Promise<string | null> {
  const cfg = readLlmConfig();
  if (cfg.mode === 'off') return null;
  if (cfg.mode === 'mock') return null;
  if (!cfg.apiKey) return null;

  try {
    const temperature = 0.2;
    const maxTokens = opts?.expectJson ? 700 : 900;
    const res = await withTimeout(
      openrouterChat({
        model: cfg.model,
        messages: messages as any,
        temperature,
        maxTokens
      }),
      cfg.timeoutMs
    );

    const text = extractAssistantText((res as any)?.content)?.trim();
    if (!text) return null;
    return text ? text : null;
  } catch {
    return null;
  }
}

export async function llmGenerateJson<T>(args: {
  system: string;
  user: unknown;
  schema: z.ZodType<T>;
  temperature?: number;
  mock?: (user: unknown) => T;
}): Promise<T | null> {
  const cfg = readLlmConfig();

  if (cfg.mode === 'mock') {
    try {
      return args.mock ? args.mock(args.user) : null;
    } catch {
      return null;
    }
  }

  if (cfg.mode !== 'full') return null;
  if (!cfg.apiKey) return null;

  const raw = await chatCompletion(
    [
      {
        role: 'system',
        content:
          args.system.trim() +
          '\n\nDevolve APENAS JSON válido. Não incluas markdown, nem texto fora do JSON.'
      },
      { role: 'user', content: JSON.stringify(args.user ?? null) }
    ],
    { expectJson: true }
  );

  if (!raw) return null;
  if (raw.length > 60_000) return null;

  const parsed = safeParseJsonLenient(raw);
  if (!parsed) return null;

  const validated = args.schema.safeParse(parsed);
  if (!validated.success) return null;
  return validated.data;
}

export async function llmGenerateText(args: {
  system: string;
  user: unknown;
  maxChars: number;
  temperature?: number;
  mock?: (user: unknown) => string;
}): Promise<string | null> {
  const cfg = readLlmConfig();

  if (cfg.mode === 'mock') {
    try {
      const out = args.mock ? String(args.mock(args.user)).trim() : '';
      if (!out) return null;
      return out.length <= args.maxChars ? out : out.slice(0, args.maxChars);
    } catch {
      return null;
    }
  }

  if (cfg.mode !== 'full') return null;
  if (!cfg.apiKey) return null;

  const raw = await chatCompletion([
    { role: 'system', content: (args.system.trim() + `\n\nResponde APENAS com texto. Máximo ${args.maxChars} caracteres.`).trim() },
    { role: 'user', content: JSON.stringify(args.user ?? null) }
  ]);

  if (!raw) return null;
  const out = raw.trim();
  if (!out) return null;
  if (out.length > args.maxChars) return out.slice(0, args.maxChars);
  return out;
}

export async function maybeRewriteAssistantReply(input: string): Promise<string | null> {
  const cfg = readLlmConfig();
  if (cfg.mode !== 'rewrite') return null;

  const out = await chatCompletion([
    {
      role: 'system',
      content:
        'Reescreve a mensagem do assistente para pt-PT (Portugal), de forma clara e natural.\n' +
        '- Mantém números, unidades e significado (não inventes dados).\n' +
        '- Mantém quebras de linha se fizer sentido.\n' +
        '- Não menciones modelos, OpenRouter, nem que és uma IA.\n' +
        '- Responde APENAS com o texto reescrito.'
    },
    { role: 'user', content: input }
  ]);

  if (!out) return null;

  // Proteção básica contra respostas muito longas
  if (out.length > 4000) return null;

  return out;
}

const InsightsRewriteSchema = z.object({
  tips: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1).max(260)
      })
    )
    .min(1)
});

export async function maybeRewriteInsights(input: {
  customerTariff: string;
  offpeakPct: number;
  nightAvgWatts: number;
  peakHourUtc: number | null;
  tips: Array<{ id: string; icon: string; text: string }>;
}): Promise<Array<{ id: string; icon: string; text: string }> | null> {
  const cfg = readLlmConfig();
  if (cfg.mode !== 'rewrite') return null;

  const compact = {
    customerTariff: input.customerTariff,
    offpeakPct: Math.round(input.offpeakPct * 100),
    nightAvgWatts: Math.round(input.nightAvgWatts),
    peakHourUtc: input.peakHourUtc,
    tips: input.tips.map((t) => ({ id: t.id, text: t.text }))
  };

  const raw = await chatCompletion(
    [
      {
        role: 'system',
        content:
          'És um assistente de eficiência energética. Vais reescrever dicas para ficarem mais úteis e humanas, em pt-PT.\n' +
          '- Não inventes dados (usa apenas os números fornecidos).\n' +
          '- Mantém o mesmo número de dicas e os mesmos IDs.\n' +
          '- Evita redundância e frases muito longas.\n' +
          'Devolve APENAS JSON no formato: {"tips":[{"id":"...","text":"..."}]}'
      },
      { role: 'user', content: JSON.stringify(compact) }
    ],
    { expectJson: true }
  );

  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const validated = InsightsRewriteSchema.safeParse(parsed);
  if (!validated.success) return null;

  const byId = new Map(validated.data.tips.map((t) => [t.id, t.text] as const));
  const out = input.tips.map((t) => {
    const next = byId.get(t.id);
    return next ? { ...t, text: next } : t;
  });

  // Garante que pelo menos 1 dica foi reescrita
  if (!out.some((t, i) => t.text !== input.tips[i]?.text)) return null;

  return out;
}
