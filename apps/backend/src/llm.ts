import type { OpenRouter } from '@openrouter/sdk';
import { z } from 'zod';

export type LlmMode = 'off' | 'rewrite' | 'full' | 'mock';

type LlmConfig = {
  mode: LlmMode;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
};

function readLlmConfig(): LlmConfig {
  const modeRaw = String(process.env.LLM_MODE ?? 'off').toLowerCase();
  const mode: LlmMode = modeRaw === 'rewrite' ? 'rewrite' : modeRaw === 'full' ? 'full' : modeRaw === 'mock' ? 'mock' : 'off';

  const apiKey = (process.env.OPENROUTER_API_KEY ?? '').trim();
  const model = (process.env.OPENROUTER_MODEL ?? 'tngtech/deepseek-r1t2-chimera:free').trim();
  const timeoutMs = Math.max(1500, Math.min(20000, Number(process.env.OPENROUTER_TIMEOUT_MS ?? 7000) || 7000));

  return { mode, apiKey: apiKey ? apiKey : null, model: model || 'tngtech/deepseek-r1t2-chimera:free', timeoutMs };
}

export function isLlmGenerationEnabled(): boolean {
  const cfg = readLlmConfig();
  return cfg.mode === 'full' || cfg.mode === 'mock';
}

let cachedClient: OpenRouter | null = null;
let cachedKey: string | null = null;

let cachedCtor: (new (args: { apiKey: string }) => OpenRouter) | null = null;

async function getOpenRouterCtor(): Promise<new (args: { apiKey: string }) => OpenRouter> {
  if (cachedCtor) return cachedCtor;
  // Import dinâmico para não rebentar o Jest (ESM em node_modules)
  const mod: any = await import('@openrouter/sdk');
  cachedCtor = mod?.OpenRouter;
  if (!cachedCtor) throw new Error('OPENROUTER_SDK_NOT_AVAILABLE');
  return cachedCtor;
}

async function getClient(apiKey: string): Promise<OpenRouter> {
  if (cachedClient && cachedKey === apiKey) return cachedClient;
  cachedKey = apiKey;
  const Ctor = await getOpenRouterCtor();
  cachedClient = new Ctor({ apiKey });
  return cachedClient;
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

async function chatCompletion(messages: ChatMessage[], opts?: { expectJson?: boolean }): Promise<string | null> {
  const cfg = readLlmConfig();
  if (cfg.mode === 'off') return null;
  if (cfg.mode === 'mock') return null;
  if (!cfg.apiKey) return null;

  try {
    const client = await getClient(cfg.apiKey);
    const res = await withTimeout(
      client.chat.send({
        model: cfg.model,
        messages: messages as any,
        temperature: 0.2,
        responseFormat: opts?.expectJson ? { type: 'json_object' } : undefined
      } as any),
      cfg.timeoutMs
    );

    const content = (res as any)?.choices?.[0]?.message?.content;
    const text = extractAssistantText(content)?.trim();
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

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
