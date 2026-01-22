import { getDefaultModel, isLlmEnabled, openrouterChat, type LlmMessage } from './openrouter';

export async function llmChatReply(input: {
  customer: { id: string; name?: string | null; tariff?: string | null; contractedPowerKva?: number | null };
  nowUtc: string;
  context: unknown;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  message: string;
}): Promise<{ reply: string } | null> {
  if (!isLlmEnabled()) return null;

  const model = getDefaultModel();

  const system =
    'Você é o assistente IA do Kynex (Portugal). Objetivo: responder com alta utilidade sobre consumo, poupança, contrato e contexto da rede. ' +
    'Regras: (1) Não invente números: use somente os valores do contexto JSON; (2) Se faltar dado, diga o que falta e peça 1 pergunta curta; (3) Seja direto (2–8 frases); (4) Sem markdown.';

  const messages: LlmMessage[] = [{ role: 'system', content: system }];
  messages.push({ role: 'user', content: `Contexto (JSON): ${JSON.stringify(input.context)}` });

  const trimmedHistory = (input.history ?? []).slice(-10);
  for (const h of trimmedHistory) {
    messages.push({ role: h.role, content: String(h.content ?? '') });
  }

  messages.push({ role: 'user', content: input.message });

  try {
    const { content } = await openrouterChat({
      model,
      temperature: 0.3,
      maxTokens: 700,
      messages
    });

    const reply = String(content ?? '').trim();
    if (!reply) return null;
    return { reply };
  } catch {
    return null;
  }
}
