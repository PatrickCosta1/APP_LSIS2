import { z } from 'zod';

export type GroqRole = 'system' | 'user' | 'assistant';
export type GroqMessage = { role: GroqRole; content: string };

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

function getBaseUrl(): string {
  const base = String(process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1').trim();
  return base.replace(/\/$/, '');
}

function getApiKey() {
  const k = process.env.GROQ_API_KEY;
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}

export function isGroqEnabled(): boolean {
  // Nunca chamar serviços externos nos testes, a menos que seja explicitamente pedido.
  if (process.env.NODE_ENV === 'test') {
    const force = String(process.env.KYNEX_GROQ_ENABLED ?? '').trim().toLowerCase();
    if (!force) return false;
    return force !== '0' && force !== 'false' && force !== 'off';
  }

  const key = getApiKey();
  if (!key) return false;

  const flag = String(process.env.KYNEX_GROQ_ENABLED ?? '').trim().toLowerCase();
  if (flag) return flag !== '0' && flag !== 'false' && flag !== 'off';

  // Compat: modo atual no .env (LLM_MODE=full|off)
  const mode = String(process.env.LLM_MODE ?? 'full').trim().toLowerCase();
  if (mode) return mode !== '0' && mode !== 'false' && mode !== 'off' && mode !== 'disabled';

  return true;
}

export function getGroqModel() {
  const m = process.env.KYNEX_CHAT_MODEL ?? process.env.GROQ_MODEL;
  if (typeof m === 'string' && m.trim()) return m.trim();
  return 'llama-3.1-8b-instant';
}

function getTimeoutMs() {
  const raw = process.env.GROQ_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 12_000;
  return Math.max(1_000, Math.min(60_000, Math.floor(n)));
}

export async function groqChat(opts: {
  messages: GroqMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<{ content: string; raw: unknown }> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('GROQ_API_KEY não definido');

  const baseUrl = getBaseUrl();

  const model = opts.model ?? getGroqModel();
  const temperature = Number.isFinite(opts.temperature as number) ? (opts.temperature as number) : 0.3;
  const maxTokens = Number.isFinite(opts.maxTokens as number) ? (opts.maxTokens as number) : 900;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());

  let res: Response;
  let text = '';
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };

    const body: any = {
      model,
      messages: opts.messages,
      temperature,
      // Groq recomenda max_completion_tokens (max_tokens é deprecated)
      max_completion_tokens: maxTokens
    };

    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    clearTimeout(timeout);
    text = await res.text();
  } catch (err) {
    console.error('[GROQ] Erro de fetch:', err);
    throw new Error('GROQ_FETCH_ERROR');
  }

  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }

  if (!res.ok) {
    console.error('[GROQ] Erro HTTP:', res.status, text.slice(0, 400));
    throw new Error(`groq erro ${res.status}: ${text.slice(0, 400)}`);
  }

  const parsed = OpenAiChatResponseSchema.safeParse(json);
  const content = parsed.success ? (parsed.data.choices[0]?.message?.content ?? '') : '';

  return { content: String(content ?? ''), raw: json ?? text };
}
