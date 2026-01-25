import { z } from 'zod';

export type LlmRole = 'system' | 'user' | 'assistant';
export type LlmMessage = { role: LlmRole; content: string };

type LlmProvider = 'openrouter' | 'groq';

const OpenAiChatResponseSchema = z.object({
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

function getProvider(): LlmProvider {
  const raw = String(process.env.LLM_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'groq' ? 'groq' : 'openrouter';
}

function getBaseUrl(provider: LlmProvider): string {
  if (provider === 'groq') {
    const base = String(process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1').trim();
    return base.replace(/\/$/, '');
  }
  return 'https://openrouter.ai/api/v1';
}

function getKeyEnvName(provider: LlmProvider): string {
  return provider === 'groq' ? 'GROQ_API_KEY' : 'OPENROUTER_API_KEY';
}

function getApiKey(provider: LlmProvider) {
  const k = provider === 'groq' ? process.env.GROQ_API_KEY : process.env.OPENROUTER_API_KEY;
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}

export function isLlmEnabled() {
  // Nunca chamar serviços externos nos testes, a menos que seja explicitamente pedido.
  if (process.env.NODE_ENV === 'test') {
    const force = String(process.env.KYNEX_LLM_ENABLED ?? '').trim().toLowerCase();
    if (!force) return false;
    return force !== '0' && force !== 'false' && force !== 'off';
  }

  const key = getApiKey(getProvider());
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
  const provider = getProvider();
  const m = process.env.KYNEX_LLM_MODEL ?? (provider === 'groq' ? process.env.GROQ_MODEL : process.env.OPENROUTER_MODEL);
  if (typeof m === 'string' && m.trim()) return m.trim();
  return provider === 'groq' ? 'llama-3.1-8b-instant' : 'arcee-ai/trinity-mini:free';
}

function getTimeoutMs() {
  const provider = getProvider();
  const raw = provider === 'groq' ? process.env.GROQ_TIMEOUT_MS : process.env.OPENROUTER_TIMEOUT_MS;
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
  const provider = getProvider();
  const apiKey = getApiKey(provider);
  if (!apiKey) throw new Error(`${getKeyEnvName(provider)} não definido`);

  const baseUrl = getBaseUrl(provider);

  const model = opts.model ?? getDefaultModel();
  const temperature = Number.isFinite(opts.temperature as number) ? (opts.temperature as number) : 0.3;
  const maxTokens = Number.isFinite(opts.maxTokens as number) ? (opts.maxTokens as number) : 900;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());

  let res, text;
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };

    // headers opcionais recomendados pelo OpenRouter
    if (provider === 'openrouter') {
      headers['X-Title'] = 'Kynex';
      headers['HTTP-Referer'] = 'http://localhost';
    }

    const body: any = {
      model,
      messages: opts.messages,
      temperature
    };

    // OpenRouter usa max_tokens; Groq recomenda max_completion_tokens (max_tokens é deprecated)
    if (provider === 'groq') body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;

    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    clearTimeout(timeout);
    text = await res.text();
  } catch (err) {
    console.error(`[LLM] Erro de fetch para ${provider}:`, err);
    throw new Error('LLM_FETCH_ERROR');
  }

  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }

  if (!res.ok) {
    console.error(`[LLM] Erro HTTP ${provider}:`, res.status, text.slice(0, 400));
    throw new Error(`${provider} erro ${res.status}: ${text.slice(0, 400)}`);
  }

  const parsed = OpenAiChatResponseSchema.safeParse(json);
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
