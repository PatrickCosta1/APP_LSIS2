import { z, type ZodSchema } from 'zod';
import { getDefaultModel, isLlmEnabled, openrouterChatJson } from './openrouter';

export type AssistantPrefs = {
  style: 'short' | 'detailed';
  focus: 'poupanca' | 'equipamentos' | 'potencia' | 'geral';
};

export type ChatAction =
  | { kind: 'button'; id: string; label: string; message: string }
  | {
      kind: 'plan';
      id: string;
      title: string;
      items: Array<{ id: string; label: string; detail?: string }>;
    };

function stripJsonFences(s: string) {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function llmJson<T>(opts: {
  purpose: string;
  schema: ZodSchema<T>;
  context: unknown;
  temperature?: number;
  maxTokens?: number;
  model?: string;
}): Promise<T | null> {
  if (!isLlmEnabled()) return null;

  const schema = opts.schema;
  const model = opts.model ?? getDefaultModel();

  try {
    const { parsed, content } = await openrouterChatJson({
      model,
      temperature: opts.temperature ?? 0.3,
      maxTokens: opts.maxTokens ?? 700,
      schema,
      messages: [
        {
          role: 'system',
          content:
            'Você é o assistente IA do Kynex (Portugal). Gere respostas MUITO personalizadas, específicas e acionáveis. ' +
            'Regras obrigatórias: (1) NÃO invente números: use apenas valores do JSON de contexto; (2) Sem markdown; (3) Responda APENAS com JSON válido; (4) Seja direto e de alto valor.'
        },
        {
          role: 'user',
          content:
            `Objetivo: ${opts.purpose}\n` +
            `Contexto (JSON): ${JSON.stringify(opts.context)}`
        }
      ]
    });

    if (parsed) return parsed as T;

    // fallback: tentar parsear manualmente (caso o modelo ignore o schema)
    const raw = stripJsonFences(String(content ?? ''));
    const json = JSON.parse(raw);
    return schema.parse(json);
  } catch {
    return null;
  }
}

export async function llmRewriteNotifications(input: {
  customer: { id: string; tariff?: string | null; contractedPowerKva?: number | null; householdSize?: number | null };
  prefs: AssistantPrefs;
  nowUtc: string;
  signals: {
    kwh24: number;
    kwhPrev24: number;
    deltaPct: number;
    nightAvgWatts: number;
    standbyThreshold: number;
    peakWatts7d: number;
    peakKva7d: number;
    contractedKva: number;
  };
  candidates: Array<{ id: string; type: string; severity: 'info' | 'warning' | 'critical'; title: string; message: string; actions?: ChatAction[] }>;
}): Promise<{ notifications: Array<{ id: string; type: string; severity: 'info' | 'warning' | 'critical'; title: string; message: string; actions?: ChatAction[] }> } | null> {
  const ActionSchema = z.union([
    z.object({ kind: z.literal('button'), id: z.string().min(1).max(40), label: z.string().min(1).max(30), message: z.string().min(1).max(200) }),
    z.object({
      kind: z.literal('plan'),
      id: z.string().min(1).max(40),
      title: z.string().min(1).max(60),
      items: z
        .array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(60), detail: z.string().max(160).optional() }))
        .min(1)
        .max(12)
    })
  ]);

  const NotificationSchema = z.object({
    id: z.string().min(1).max(120),
    type: z.string().min(1).max(60),
    severity: z.enum(['info', 'warning', 'critical']),
    title: z.string().min(4).max(60),
    message: z.string().min(12).max(220),
    actions: z.array(ActionSchema).max(6).optional()
  });

  const Schema = z.object({ notifications: z.array(NotificationSchema).min(0).max(8) });

  return llmJson({
    purpose:
      'Reescrever notificações do assistente para ficarem extremamente úteis. Pode reordenar e remover itens de baixo valor, mas mantenha os ids/types existentes. Use os números do contexto. Linguagem PT-BR/PT-PT.',
    schema: Schema,
    context: input,
    temperature: 0.25,
    maxTokens: 800
  });
}

export async function llmAppliancesSummarySuggestion(input: {
  customer: { id: string };
  prefs: AssistantPrefs;
  nowUtc: string;
  days: number;
  month: string | null;
  totalCostEur: number;
  top: { name: string; category?: string | null; costEur: number; energyKwh: number; sharePct: number; sessions: number } | null;
  itemsTop3: Array<{ name: string; costEur: number; sharePct: number }>;
  heuristicSuggestion: string;
  estimatedSavingsMonthEur: number | null;
}): Promise<{ suggestion: string } | null> {
  const Schema = z.object({ suggestion: z.string().min(12).max(180) });
  return llmJson({
    purpose:
      'Gerar UMA sugestão curta (1–2 frases) baseada no resumo de equipamentos, com ação concreta e, quando possível, citando o custo/percentual do topo. Não inventar valores. Sem generalidades.',
    schema: Schema,
    context: input,
    temperature: 0.3,
    maxTokens: 220
  });
}

export async function llmApplianceTip(input: {
  customer: { id: string; tariff?: string | null };
  prefs: AssistantPrefs;
  nowUtc: string;
  appliance: { id: number; name: string; category?: string | null; standbyWatts: number | null };
  windowDays: number;
  totals: { totalKwh: number; totalCostEur: number; sharePct: number };
  usageShape: {
    dominantHourUtc: number;
    offpeakPct: number;
    peakPct: number;
    dominantInOffpeak: boolean;
    dominantInPeak: boolean;
    isTou: boolean;
    isFlexible: boolean;
    corrHotCold: number;
  };
  heuristicTip: string;
}): Promise<{ tip: string } | null> {
  const Schema = z.object({ tip: z.string().min(12).max(220) });
  return llmJson({
    purpose:
      'Gerar UMA dica extremamente personalizada para este equipamento (1–2 frases), usando o perfil horário e tarifa. Deve ser acionável e específica para o caso. Não inventar dados.',
    schema: Schema,
    context: input,
    temperature: 0.3,
    maxTokens: 240
  });
}

export async function llmPowerSuggestionCopy(input: {
  customer: { id: string; segment?: string | null; tariff?: string | null };
  prefs: AssistantPrefs;
  nowUtc: string;
  fields: {
    status: 'ok' | 'sobredimensionado' | 'subdimensionado';
    contractedKva: number;
    suggestedIdealKva: number;
    yearlyPeakKva: number;
    usagePctOfContracted: number;
    riskExceedPct: number;
    savingsMonth: number;
    modelUsed: 'ai' | 'heuristic';
  };
  heuristic: { title: string; message: string };
}): Promise<{ title: string; message: string } | null> {
  const Schema = z.object({ title: z.string().min(4).max(40), message: z.string().min(12).max(220) });
  return llmJson({
    purpose:
      'Escrever título+mensagem de recomendação de potência contratada. Deve explicar o porquê em linguagem simples, citando risco e poupança quando existirem. Não inventar números.',
    schema: Schema,
    context: input,
    temperature: 0.25,
    maxTokens: 260
  });
}

export async function llmContractAnalysisMessage(input: {
  customer: { id: string; tariff: string; utility?: string | null };
  prefs: AssistantPrefs;
  nowUtc: string;
  fields: {
    forecastMonthKwh: number;
    offpeakPct: number;
    currentTariff: string;
    bestTariff: string;
    deltaMonthEur: number;
  };
  heuristicMessage: string;
}): Promise<{ message: string } | null> {
  const Schema = z.object({ message: z.string().min(12).max(220) });
  return llmJson({
    purpose:
      'Reescrever a mensagem de recomendação de tarifa/contrato para ser altamente personalizada e acionável, usando offpeakPct e deltaMonthEur. Não inventar valores.',
    schema: Schema,
    context: input,
    temperature: 0.25,
    maxTokens: 240
  });
}

export async function llmSecurityKynexNodeAlertCopy(input: {
  customer: { id: string };
  prefs: AssistantPrefs;
  nowUtc: string;
  signals: {
    anomalyDeviceName: string | null;
    globalAnomaly: boolean;
    last2hAvgWatts: number;
    hourMedianWatts: number;
  };
  heuristic: { title: string; message: string; severity: 'info' | 'warning' | 'critical' };
}): Promise<{ title: string; message: string } | null> {
  const Schema = z.object({ title: z.string().min(4).max(60), message: z.string().min(12).max(220) });
  return llmJson({
    purpose:
      'Reescrever o alerta do Kynex Node (segurança/consumo anómalo) para ser muito claro e acionável. Deve dizer o que aconteceu e o que fazer em 1–2 frases. Não inventar números; use os watts do contexto quando fizer sentido.',
    schema: Schema,
    context: input,
    temperature: 0.25,
    maxTokens: 220
  });
}

export async function llmRewriteMarketOffers(input: {
  customer: { id: string; utility?: string | null; tariff?: string | null };
  prefs: AssistantPrefs;
  nowUtc: string;
  context: {
    forecastMonthKwh: number;
    offpeakPct: number;
    currentTariff: string;
    currentMonthEur: number;
  };
  offers: Array<{
    provider: string;
    name: string;
    tariff: string;
    savingsMonthEur: number;
    savingsYearEur: number;
    why: string;
  }>;
}): Promise<{ offers: Array<{ provider: string; name: string; why: string }> } | null> {
  const OfferSchema = z.object({
    provider: z.string().min(1).max(40),
    name: z.string().min(1).max(60),
    why: z.string().min(12).max(160)
  });
  const Schema = z.object({ offers: z.array(OfferSchema).min(1).max(8) });

  return llmJson({
    purpose:
      'Reescrever o campo why de cada oferta (1 frase, no máximo 2) para ficar personalizado e de alto valor. Mantenha provider+name exatamente como no input para conseguirmos mapear. Não inventar números; use savingsMonthEur/savingsYearEur/offpeakPct quando ajudar.',
    schema: Schema,
    context: input,
    temperature: 0.25,
    maxTokens: 450
  });
}
