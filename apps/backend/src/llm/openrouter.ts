import crypto from 'node:crypto';
import { z } from 'zod';

export type LlmRole = 'system' | 'user' | 'assistant';
export type LlmMessage = { role: LlmRole; content: string };

type LlmProvider = 'openrouter' | 'groq';

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}

function estimateTokensFromText(text: string): number {
  // Heurística simples: ~4 chars/token (funciona OK para PT/EN na prática)
  const s = String(text ?? '');
  return Math.max(1, Math.ceil(s.length / 4));
}

function getEnvInt(name: string, fallback: number): number {
  const raw = String(process.env[name] ?? '').trim();
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function getEnvBool(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

type RateState = {
  tokens: Array<{ ts: number; tokens: number }>;
  reqs: number[];
};

const rateStateByProvider: Record<LlmProvider, RateState> = {
  openrouter: { tokens: [], reqs: [] },
  groq: { tokens: [], reqs: [] }
};

const inflightByKey = new Map<string, Promise<{ content: string; raw: unknown }>>();
const cacheByKey = new Map<string, { ts: number; value: { content: string; raw: unknown } }>();

function stableKey(provider: LlmProvider, model: string, temperature: number, maxTokens: number, messages: LlmMessage[]) {
  const payload = JSON.stringify({ provider, model, temperature: Number(temperature.toFixed(3)), maxTokens, messages });
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function getCacheTtlMs(provider: LlmProvider) {
  const def = provider === 'groq' ? 45_000 : 30_000;
  return Math.max(0, getEnvInt('KYNEX_LLM_CACHE_TTL_MS', def));
}

function pruneRateState(state: RateState, now: number) {
  const cutoff = now - 60_000;
  while (state.reqs.length && state.reqs[0]! < cutoff) state.reqs.shift();
  while (state.tokens.length && state.tokens[0]!.ts < cutoff) state.tokens.shift();
}

function getProviderLimits(provider: LlmProvider) {
  // Defaults conservadores para reduzir 429, especialmente na Groq (TPM baixo no free/on_demand)
  const defaultTpm = provider === 'groq' ? 5_500 : 24_000;
  const defaultRpm = provider === 'groq' ? 25 : 60;
  const tpmLimit = Math.max(500, getEnvInt('KYNEX_LLM_TPM_LIMIT', defaultTpm));
  const rpmLimit = Math.max(5, getEnvInt('KYNEX_LLM_RPM_LIMIT', defaultRpm));
  const maxQueueWaitMs = Math.max(0, getEnvInt('KYNEX_LLM_MAX_QUEUE_WAIT_MS', provider === 'groq' ? 9_000 : 6_000));
  return { tpmLimit, rpmLimit, maxQueueWaitMs };
}

async function rateLimitWait(provider: LlmProvider, estimatedTokens: number, maxWaitMsOverride?: number) {
  const state = rateStateByProvider[provider];
  const now = Date.now();
  pruneRateState(state, now);

  const { tpmLimit, rpmLimit, maxQueueWaitMs } = getProviderLimits(provider);
  const maxWaitMs = typeof maxWaitMsOverride === 'number' && Number.isFinite(maxWaitMsOverride) ? Math.max(0, maxWaitMsOverride) : maxQueueWaitMs;

  const reqsUsed = state.reqs.length;
  const tokensUsed = state.tokens.reduce((acc, e) => acc + e.tokens, 0);

  let waitMs = 0;

  // RPM
  if (reqsUsed + 1 > rpmLimit && state.reqs.length) {
    const oldest = state.reqs[0]!;
    waitMs = Math.max(waitMs, oldest + 60_000 - now);
  }

  // TPM
  if (tokensUsed + estimatedTokens > tpmLimit && state.tokens.length) {
    let need = tokensUsed + estimatedTokens - tpmLimit;
    for (const e of state.tokens) {
      need -= e.tokens;
      if (need <= 0) {
        waitMs = Math.max(waitMs, e.ts + 60_000 - now);
        break;
      }
    }
  }

  if (waitMs <= 0) return;
  if (waitMs > maxWaitMs) {
    throw new Error('LLM_RATE_LIMIT_LOCAL');
  }
  await sleep(waitMs);
}

function recordUsage(provider: LlmProvider, estimatedTokens: number) {
  const state = rateStateByProvider[provider];
  const now = Date.now();
  pruneRateState(state, now);
  state.reqs.push(now);
  state.tokens.push({ ts: now, tokens: Math.max(1, Math.floor(estimatedTokens)) });
}

function truncateTextForLlm(s: string, maxChars: number): string {
  const t = String(s ?? '');
  if (maxChars <= 0) return '';
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 15) + '\n…(truncado)';
}

function compactMessagesForLlm(messages: LlmMessage[], provider: LlmProvider): LlmMessage[] {
  const maxMsgChars = Math.max(800, getEnvInt('KYNEX_LLM_MAX_MSG_CHARS', provider === 'groq' ? 5_500 : 8_000));
  const maxTotalChars = Math.max(2_000, getEnvInt('KYNEX_LLM_MAX_TOTAL_CHARS', provider === 'groq' ? 12_000 : 18_000));

  const truncateEnabled = getEnvBool('KYNEX_LLM_TRUNCATE_INPUT', true);
  const normalize = (m: LlmMessage): LlmMessage =>
    truncateEnabled ? { ...m, content: truncateTextForLlm(m.content, maxMsgChars) } : { ...m, content: String(m.content ?? '') };

  const out: LlmMessage[] = [];
  let total = 0;

  // mantém o 1º system se existir
  let startIdx = 0;
  if (messages[0]?.role === 'system') {
    const sys = normalize(messages[0]);
    out.push(sys);
    total += sys.content.length;
    startIdx = 1;
  }

  const tail = messages.slice(startIdx).map(normalize);
  const keptRev: LlmMessage[] = [];

  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const m = tail[i]!;

    // garante que o último input do utilizador não é dropado
    if (keptRev.length === 0) {
      keptRev.push(m);
      total += m.content.length;
      continue;
    }

    if (total + m.content.length > maxTotalChars) continue;
    keptRev.push(m);
    total += m.content.length;
  }

  out.push(...keptRev.reverse());
  return out;
}

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
  maxQueueWaitMs?: number;
}): Promise<{ content: string; raw: unknown }> {
  const provider = getProvider();
  const apiKey = getApiKey(provider);
  if (!apiKey) throw new Error(`${getKeyEnvName(provider)} não definido`);

  const baseUrl = getBaseUrl(provider);

  const model = opts.model ?? getDefaultModel();
  const temperature = Number.isFinite(opts.temperature as number) ? (opts.temperature as number) : 0.3;
  const maxTokens = Number.isFinite(opts.maxTokens as number) ? (opts.maxTokens as number) : 900;

  const messages = compactMessagesForLlm(opts.messages ?? [], provider);

  const canCache = temperature <= 0.25;
  const cacheKey = canCache ? stableKey(provider, model, temperature, maxTokens, messages) : null;
  if (cacheKey) {
    const cached = cacheByKey.get(cacheKey);
    const ttl = getCacheTtlMs(provider);
    if (cached && Date.now() - cached.ts <= ttl) {
      return cached.value;
    }

    const inflight = inflightByKey.get(cacheKey);
    if (inflight) return await inflight;
  }

  // limitação local para reduzir 429 (especialmente Groq)
  const estimatedInputTokens = messages.reduce((acc, m) => acc + estimateTokensFromText(m.content), 0);
  const estimatedTotalTokens = estimatedInputTokens + Math.max(1, Math.floor(maxTokens));

  const run = async () => {
    await rateLimitWait(provider, estimatedTotalTokens, opts.maxQueueWaitMs);

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
    messages,
    temperature
  };

  // OpenRouter usa max_tokens; Groq recomenda max_completion_tokens (max_tokens é deprecated)
  if (provider === 'groq') body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;

  const parseRetryAfterMs = (res: Response | null, text: string): number | null => {
    const h = res?.headers?.get('retry-after');
    if (h) {
      const n = Number(h);
      if (Number.isFinite(n) && n > 0) return Math.min(30_000, Math.floor(n * 1000));
    }
    const m = String(text ?? '').match(/try again in\s+([0-9.]+)s/i);
    if (m?.[1]) {
      const sec = Number(m[1]);
      if (Number.isFinite(sec) && sec > 0) return Math.min(30_000, Math.floor(sec * 1000));
    }
    return null;
  };

    const maxAttempts = provider === 'groq' ? 2 : 2;

    let res: Response | null = null;
    let text = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), getTimeoutMs());
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify(body)
        });
        clearTimeout(timeout);
        text = await res.text();
      } catch (err) {
        clearTimeout(timeout);
        console.error(`[LLM] Erro de fetch para ${provider}:`, err);
        throw new Error('LLM_FETCH_ERROR');
      }

      if (res.ok) break;

      // Retry rápido em 429 (rate-limit) com base em retry-after / mensagem
      if (res.status === 429 && attempt < maxAttempts) {
        const delayMs = parseRetryAfterMs(res, text) ?? 2_000;
        await sleep(Math.min(12_000, delayMs + Math.floor(Math.random() * 250)));
        continue;
      }

      break;
    }

  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }

    if (!res) {
      throw new Error('LLM_FETCH_ERROR');
    }

    if (!res.ok) {
      console.error(`[LLM] Erro HTTP ${provider}:`, res.status, text.slice(0, 400));
      throw new Error(`${provider} erro ${res.status}: ${text.slice(0, 400)}`);
    }

    const parsed = OpenAiChatResponseSchema.safeParse(json);
    const content = parsed.success ? (parsed.data.choices[0]?.message?.content ?? '') : '';

    // “contabiliza” depois de sucesso, para limitar burst sem penalizar falhas
    recordUsage(provider, estimatedTotalTokens);

    const value = { content: String(content ?? ''), raw: json ?? text };
    if (cacheKey) {
      cacheByKey.set(cacheKey, { ts: Date.now(), value });
    }
    return value;
  };

  if (cacheKey) {
    const p = run().finally(() => inflightByKey.delete(cacheKey));
    inflightByKey.set(cacheKey, p);
    return await p;
  }

  return await run();
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
