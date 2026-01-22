import { z } from 'zod';

export type LlmRole = 'system' | 'user' | 'assistant';
export type LlmMessage = { role: LlmRole; content: string };

const OpenRouterChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.string().optional(),
          content: z.string().optional().nullable()
        })
      })
    )
    .default([])
});

function getApiKey() {
  const k = process.env.OPENROUTER_API_KEY;
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}

export function isLlmEnabled() {
  // Nunca chamar serviços externos nos testes, a menos que seja explicitamente pedido.
  if (process.env.NODE_ENV === 'test') {
    const force = String(process.env.KYNEX_LLM_ENABLED ?? '').trim().toLowerCase();
    if (!force) return false;
    return force !== '0' && force !== 'false' && force !== 'off';
  }

  const key = getApiKey();
  if (!key) return false;

  // Compat: modo antigo
  const flag = String(process.env.KYNEX_LLM_ENABLED ?? '').trim().toLowerCase();
  if (flag) return flag !== '0' && flag !== 'false' && flag !== 'off';

  // Compat: modo atual no .env (LLM_MODE=full|off)
  const mode = String(process.env.LLM_MODE ?? 'full').trim().toLowerCase();
  if (mode) return mode !== '0' && mode !== 'false' && mode !== 'off' && mode !== 'disabled';

  return true;
}

export function getDefaultModel() {
  const m = process.env.KYNEX_LLM_MODEL ?? process.env.OPENROUTER_MODEL;
  return typeof m === 'string' && m.trim() ? m.trim() : 'arcee-ai/trinity-mini:free';
}

function getTimeoutMs() {
  const raw = process.env.OPENROUTER_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 12_000;
  return Math.max(1_000, Math.min(60_000, Math.floor(n)));
}

export async function openrouterChat(opts: {
  messages: LlmMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<{ content: string; raw: unknown }> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY não definido');

  const model = opts.model ?? getDefaultModel();
  const temperature = Number.isFinite(opts.temperature as number) ? (opts.temperature as number) : 0.3;
  const maxTokens = Number.isFinite(opts.maxTokens as number) ? (opts.maxTokens as number) : 900;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // headers opcionais recomendados pelo OpenRouter
      'X-Title': 'Kynex',
      'HTTP-Referer': 'http://localhost'
    },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      messages: opts.messages,
      temperature,
      max_tokens: maxTokens
    })
  });

  clearTimeout(timeout);

  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }

  if (!res.ok) {
    throw new Error(`OpenRouter erro ${res.status}: ${text.slice(0, 400)}`);
  }

  const parsed = OpenRouterChatResponseSchema.safeParse(json);
  const content = parsed.success ? (parsed.data.choices[0]?.message?.content ?? '') : '';

  return { content: String(content ?? ''), raw: json ?? text };
}

export async function openrouterChatJson<T>(opts: {
  messages: LlmMessage[];
  schema: z.ZodType<T>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<{ parsed: T | null; content: string; raw: unknown }> {
  const { content, raw } = await openrouterChat(opts);

  const cleaned = content.trim();
  const maybeJson = cleaned.startsWith('```') ? cleaned.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim() : cleaned;

  try {
    const obj = JSON.parse(maybeJson);
    const parsed = opts.schema.safeParse(obj);
    if (parsed.success) return { parsed: parsed.data, content, raw };
  } catch {
    // ignore
  }

  return { parsed: null, content, raw };
}
