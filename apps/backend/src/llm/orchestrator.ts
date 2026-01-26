import { getDefaultModel, isLlmEnabled, openrouterChat, type LlmMessage } from './openrouter';

function safeJsonPreview(obj: unknown, maxChars: number) {
  try {
    const s = JSON.stringify(obj ?? null);
    if (s.length <= maxChars) return s;
    return s.slice(0, Math.max(0, maxChars - 15)) + '…(truncado)';
  } catch {
    return String(obj ?? '');
  }
}

function buildHeuristicChatFallback(input: {
  customer: { id: string; name?: string | null; tariff?: string | null; contractedPowerKva?: number | null };
  nowUtc: string;
  context: unknown;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  message: string;
}): string {
  const tariff = String(input.customer?.tariff ?? '').trim();
  const power = input.customer?.contractedPowerKva;
  const questions: string[] = [];

  // tenta fazer 1 pergunta curta para orientar (sem inventar dados)
  const msg = String(input.message ?? '').toLowerCase();
  if (msg.includes('tarifa') || msg.includes('bi') || msg.includes('simples')) {
    questions.push('Quer que eu compare tarifa simples vs bi-horário com base nos seus horários (vazio/cheias)?');
  } else if (msg.includes('pico') || msg.includes('potência') || msg.includes('disjuntor')) {
    questions.push('Em que hora costuma acontecer o pico (ex.: 19h) e quais aparelhos estavam ligados?');
  } else {
    questions.push('Para eu ajudar melhor: o objetivo é reduzir custo, reduzir picos, ou entender um equipamento específico?');
  }

  const tips: string[] = [];
  tips.push('1) Se tem consumos flexíveis (lavar/secar/termoacumulador), tente concentrar no vazio/noite quando possível.');
  tips.push('2) Ataque o stand-by: box/TV/PC e carregadores na tomada à noite costumam ser os maiores “vazamentos” de energia.');
  tips.push('3) Se sente picos no fim da tarde, evite ligar vários aparelhos de aquecimento ao mesmo tempo (ex.: forno + termo + AC).');

  const header = 'Neste momento estou com limitação temporária no serviço de IA; vou responder em modo heurístico.';
  const ctxHint = tariff ? `Tarifa atual: ${tariff}.` : '';
  const powerHint = typeof power === 'number' && Number.isFinite(power) ? `Potência contratada: ${power} kVA.` : '';

  const out = [header, ctxHint, powerHint, tips.join(' '), questions[0] ?? 'O que quer otimizar primeiro?'].filter(Boolean).join(' ');
  return out.length <= 1200 ? out : out.slice(0, 1185).trimEnd() + '…';
}

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
    'Você é o assistente do Kynex (Portugal). Responda de forma útil sobre consumo, poupança, contrato e rede. ' +
    'Regras: não invente números; se faltar dado, diga o que falta e faça 1 pergunta curta; 2–8 frases; sem markdown.';

  const messages: LlmMessage[] = [{ role: 'system', content: system }];
  messages.push({ role: 'user', content: `Contexto (JSON): ${safeJsonPreview(input.context, 6000)}` });

  const trimmedHistory = (input.history ?? []).slice(-6);
  for (const h of trimmedHistory) {
    messages.push({ role: h.role, content: String(h.content ?? '') });
  }

  messages.push({ role: 'user', content: input.message });

  try {
    const { content } = await openrouterChat({
      model,
      temperature: 0.3,
      maxTokens: 420,
      maxQueueWaitMs: 9_000,
      messages
    });

    const reply = String(content ?? '').trim();
    if (!reply) return null;
    return { reply };
  } catch {
    return { reply: buildHeuristicChatFallback(input) };
  }
}
