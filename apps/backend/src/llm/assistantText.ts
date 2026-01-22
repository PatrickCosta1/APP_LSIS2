import { getDefaultModel, isLlmEnabled, openrouterChat, type LlmMessage } from './openrouter';

export type AssistantTextKind =
  | 'appliances_summary_suggestion'
  | 'appliance_weekly_tip'
  | 'ai_insights_summary'
  | 'electrical_health_warning'
  | 'power_suggestion_message'
  | 'security_alert_message'
  | 'contract_tariff_suggestion_message';

function cleanText(raw: string) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const unwrapped = trimmed
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/```\s*$/, '')
    .trim();
  return unwrapped.replace(/^"|"$/g, '').trim();
}

function buildSystem(kind: AssistantTextKind) {
  const base =
    'Você é o assistente IA do Kynex (Portugal). Gere uma mensagem curta e útil para utilizadores finais. ' +
    'Regras: (1) Não invente números: use apenas os valores do JSON; (2) Se faltar algum dado, não invente — use o texto de fallback; ' +
    '(3) Sem markdown; (4) Português simples (pt-PT), direto; (5) 1–4 frases; (6) Sem jargão.';

  const byKind: Record<AssistantTextKind, string> = {
    appliances_summary_suggestion:
      'Objetivo: sugerir 1 ação concreta para reduzir custo (ou reforçar boa prática) com base no top de custos do mês/janela.',
    appliance_weekly_tip:
      'Objetivo: dica curtíssima e acionável para este equipamento na última janela (horário, hábitos, stand-by). Evite mencionar kWh, €, %.',
    ai_insights_summary:
      'Objetivo: resumir em 2–4 frases os principais insights do cliente (tarifa/horas, stand-by, contexto da rede E-REDES) e 1 próxima ação.',
    electrical_health_warning:
      'Objetivo: se houver risco/atenção, explicar numa frase e dar 1 ação imediata para evitar exceder a potência.',
    power_suggestion_message:
      'Objetivo: explicar a sugestão de potência contratada de forma clara e prática (custo vs risco), sem parecer técnico.',
    security_alert_message:
      'Objetivo: explicar o alerta de segurança/consumo anómalo em linguagem simples e dizer o que fazer a seguir.',
    contract_tariff_suggestion_message:
      'Objetivo: explicar a sugestão de tarifa (simples vs bi-horário) de forma prática. Pode mencionar € e % se estiverem no JSON.'
  };

  return `${base} ${byKind[kind]}`;
}

export async function llmImproveText(opts: {
  kind: AssistantTextKind;
  customer: { id: string; name?: string | null; tariff?: string | null };
  context: unknown;
  draft: string;
  maxTokens?: number;
}): Promise<string | null> {
  if (!isLlmEnabled()) return null;

  const draft = String(opts.draft ?? '').trim();
  if (!draft) return null;

  const system = buildSystem(opts.kind);
  const model = getDefaultModel();

  const messages: LlmMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: `Cliente: ${JSON.stringify(opts.customer ?? {})}` },
    { role: 'user', content: `Dados (JSON): ${JSON.stringify(opts.context ?? {})}` },
    {
      role: 'user',
      content:
        'TEXTO_ATUAL (fallback heurístico):\n' +
        draft +
        '\n\nTarefa: reescreve o TEXTO_ATUAL para ficar mais claro e personalizado, mantendo o mesmo significado. ' +
        'Devolve APENAS o texto final.'
    }
  ];

  try {
    const { content } = await openrouterChat({
      model,
      temperature: 0.2,
      maxTokens: Number.isFinite(opts.maxTokens as number) ? (opts.maxTokens as number) : 160,
      messages
    });
    const out = cleanText(content);
    if (!out) return null;
    // não deixe o LLM gerar um "relatório".
    if (out.length > 260) return null;
    return out;
  } catch {
    return null;
  }
}

export async function llmGenerateText(opts: {
  kind: AssistantTextKind;
  customer: { id: string; name?: string | null; tariff?: string | null };
  context: unknown;
  prompt: string;
  maxTokens?: number;
}): Promise<string | null> {
  if (!isLlmEnabled()) return null;

  const system = buildSystem(opts.kind);
  const model = getDefaultModel();

  const messages: LlmMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: `Cliente: ${JSON.stringify(opts.customer ?? {})}` },
    { role: 'user', content: `Dados (JSON): ${JSON.stringify(opts.context ?? {})}` },
    { role: 'user', content: String(opts.prompt ?? '').trim() }
  ];

  try {
    const { content } = await openrouterChat({
      model,
      temperature: 0.25,
      maxTokens: Number.isFinite(opts.maxTokens as number) ? (opts.maxTokens as number) : 220,
      messages
    });
    const out = cleanText(content);
    if (!out) return null;
    if (out.length > 600) return null;
    return out;
  } catch {
    return null;
  }
}
