import crypto from 'node:crypto';
import { z } from 'zod';
import type { Collections, CustomerDoc } from './db';
import { llmGenerateJson, maybeRewriteAssistantReply } from './llm';

export const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().min(1).optional()
});

export type ChatMessageRole = 'user' | 'assistant' | 'system';

export type ChatCard =
  | { kind: 'metric'; title: string; value: string; subtitle?: string }
  | { kind: 'tip'; title: string; detail: string }
  | { kind: 'list'; title: string; items: string[]; subtitle?: string };

export type ChatAction =
  | { kind: 'button'; id: string; label: string; message: string }
  | {
      kind: 'plan';
      id: string;
      title: string;
      items: Array<{ id: string; label: string; detail?: string }>;
    };

export type ChatHistoryItem = { role: ChatMessageRole; content: string; createdAt: string };

export type ChatHistoryResponse = {
  conversationId: string | null;
  messages: ChatHistoryItem[];
};

export type ChatReplyResponse = {
  conversationId: string;
  reply: string;
  cards?: ChatCard[];
  actions?: ChatAction[];
};

const LlmChatCardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('metric'), title: z.string().min(1).max(80), value: z.string().min(1).max(40), subtitle: z.string().min(1).max(80).optional() }),
  z.object({ kind: z.literal('tip'), title: z.string().min(1).max(80), detail: z.string().min(1).max(240) }),
  z.object({ kind: z.literal('list'), title: z.string().min(1).max(80), items: z.array(z.string().min(1).max(80)).min(1).max(8), subtitle: z.string().min(1).max(80).optional() })
]);

const LlmChatActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('button'), id: z.string().min(1).max(32), label: z.string().min(1).max(28), message: z.string().min(1).max(200) }),
  z.object({
    kind: z.literal('plan'),
    id: z.string().min(1).max(32),
    title: z.string().min(1).max(60),
    items: z.array(z.object({ id: z.string().min(1).max(32), label: z.string().min(1).max(60), detail: z.string().min(1).max(120).optional() })).min(1).max(10)
  })
]);

const LlmChatReplySchema = z.object({
  reply: z.string().min(1).max(2500),
  cards: z.array(LlmChatCardSchema).max(8).optional(),
  actions: z.array(LlmChatActionSchema).max(8).optional()
});

const SAFE_MAX_HISTORY = 50;

type ChatIntent =
  | 'help'
  | 'sensitive'
  | 'feedback'
  | 'prefs'
  | 'explain'
  | 'plan_7d'
  | 'tariff_sim'
  | 'compare_peers'
  | 'what_if'
  | 'alerts'
  | 'last_24h'
  | 'last_7d'
  | 'month_to_date'
  | 'appliances_top'
  | 'appliance_actions'
  | 'efficiency'
  | 'power'
  | 'tips';

type PendingState =
  | {
      type: 'suggest_appliance_actions';
      windowDays?: number;
    }
  | {
      type: 'show_appliances_top';
      windowDays?: number;
    }
  | {
      type: 'show_efficiency';
      windowDays?: number;
    };

type ConversationState = {
  lastIntent?: ChatIntent;
  lastWindowDays?: number;
  lastTopLimit?: number;
  pending?: PendingState;
  lastExplain?: {
    topic: 'appliances_top' | 'appliance_actions' | 'efficiency' | 'power' | 'tips' | 'last_24h' | 'last_7d' | 'month_to_date';
    windowDays?: number;
    applianceName?: string;
  };
};

const ACTION_PLAN_7D = '__ACTION:PLAN_7D__';
const ACTION_FEEDBACK_UP = '__ACTION:FEEDBACK:UP__';
const ACTION_FEEDBACK_DOWN = '__ACTION:FEEDBACK:DOWN__';

type AssistantPrefs = {
  style: 'short' | 'detailed';
  focus: 'poupanca' | 'equipamentos' | 'potencia' | 'geral';
};

function parseNumberPt(s: string): number | null {
  const cleaned = s.replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseRequestedPowerKva(message: string): number | null {
  const m = message.toLowerCase();
  const mm = m.match(/\b([0-9]{1,2}(?:[\.,][0-9]{1,2})?)\s*kva\b/);
  if (mm) {
    const n = parseNumberPt(mm[1]);
    if (n && n > 0 && n <= 60) return n;
  }
  return null;
}

function parseRequestedTariff(message: string): 'simples' | 'bi' | 'tri' | null {
  const m = message.toLowerCase();
  if (m.includes('bi-hor') || m.includes('bi hor') || m.includes('bihor')) return 'bi';
  if (m.includes('tri-hor') || m.includes('tri hor') || m.includes('trihor')) return 'tri';
  if (m.includes('simples')) return 'simples';
  return null;
}

function parseAlertCommand(message: string): { kind: 'spike_pct' | 'standby_watts' | 'near_power_pct'; value: number } | null {
  const m = message.toLowerCase();
  // exemplos: "alerta 20%", "alerta standby 180w", "alerta potencia 90%"
  const spike = m.match(/\balerta\b.*\b([0-9]{1,3})\s*%\b/);
  if (spike && !m.includes('poten')) {
    const n = Number(spike[1]);
    if (Number.isFinite(n) && n >= 5 && n <= 200) return { kind: 'spike_pct', value: n };
  }
  const standby = m.match(/\balerta\b.*\bstand\w*\b.*\b([0-9]{2,4})\s*w\b/);
  if (standby) {
    const n = Number(standby[1]);
    if (Number.isFinite(n) && n >= 50 && n <= 2000) return { kind: 'standby_watts', value: n };
  }
  const power = m.match(/\balerta\b.*\bpoten\w*\b.*\b([0-9]{2,3})\s*%\b/);
  if (power) {
    const n = Number(power[1]);
    if (Number.isFinite(n) && n >= 60 && n <= 100) return { kind: 'near_power_pct', value: n };
  }
  return null;
}

function parseFeedbackAction(message: string): 'up' | 'down' | null {
  const t = message.trim();
  if (t === ACTION_FEEDBACK_UP) return 'up';
  if (t === ACTION_FEEDBACK_DOWN) return 'down';
  return null;
}

function inferPrefsFromMessage(message: string): Partial<AssistantPrefs> | null {
  const m = message.toLowerCase();
  const next: Partial<AssistantPrefs> = {};

  if (m.includes('responde curto') || m.includes('mais curto') || m.includes('curto e direto') || m.includes('curto')) {
    next.style = 'short';
  }
  if (m.includes('mais detalhe') || m.includes('detalha') || m.includes('explica melhor') || m.includes('detalhado')) {
    next.style = 'detailed';
  }

  if (m.includes('foco em poupan') || m.includes('quero poupar') || m.includes('poupança')) next.focus = 'poupanca';
  if (m.includes('foco em equip') || m.includes('equipamentos')) next.focus = 'equipamentos';
  if (m.includes('foco em pot') || m.includes('potência') || m.includes('potencia')) next.focus = 'potencia';
  if (m.includes('foco geral') || m.includes('geral')) next.focus = 'geral';

  return Object.keys(next).length ? next : null;
}

function isExplainRequest(message: string) {
  const t = message.trim().toLowerCase();
  if (!t) return false;
  if (t === 'porquê' || t === 'por que' || t === 'porque' || t === 'porquê?' || t === 'por que?' || t === 'porque?') return true;
  if (t.startsWith('porquê') || t.startsWith('por que') || t.startsWith('porque')) return true;
  return false;
}

function isPlan7dRequest(message: string) {
  const t = message.trim().toLowerCase();
  if (t === ACTION_PLAN_7D.toLowerCase()) return true;
  if (t.includes('plano') && (t.includes('7 dias') || t.includes('sete dias'))) return true;
  if (t.includes('aplicar') && t.includes('plano')) return true;
  return false;
}

function wattsSamplesToKwh(sumWatts: number) {
  // Cada amostra representa 15 minutos -> 0.25 horas
  return (sumWatts * 0.25) / 1000;
}

function fmtEur(v: number) {
  return `${v.toFixed(2)}€`;
}

function fmtHour(h: number) {
  const hh = ((h % 24) + 24) % 24;
  return `${String(hh).padStart(2, '0')}:00`;
}

async function persistAssistantMessage(c: Collections, customerId: string, conversationId: string, reply: string): Promise<string> {
  const maybeRewritten = await maybeRewriteAssistantReply(reply);
  const content = maybeRewritten ?? reply;
  const assistantMsgId = crypto.randomUUID();
  await c.chatMessages.insertOne({
    id: assistantMsgId,
    customer_id: customerId,
    conversation_id: conversationId,
    role: 'assistant',
    content,
    created_at: new Date()
  });
  return content;
}

function parseWindowDays(message: string): number | null {
  const m = message.toLowerCase();
  if (m.includes('30 dias') || m.includes('últimos 30') || m.includes('ultimos 30')) return 30;
  if (m.includes('14 dias') || m.includes('últimos 14') || m.includes('ultimos 14')) return 14;
  if (m.includes('7 dias') || m.includes('semana')) return 7;
  if (m.includes('24h') || m.includes('24 h') || m.includes('ontem')) return 1;
  const rx = /([0-9]{1,3})\s*(dias|dia)/i;
  const mm = m.match(rx);
  if (mm) {
    const n = Number(mm[1]);
    if (Number.isFinite(n) && n > 0 && n <= 120) return Math.floor(n);
  }
  return null;
}

function isSensitiveRequest(message: string) {
  const m = message.toLowerCase();
  return (
    m.includes('mongodb_uri') ||
    m.includes('openai_api_key') ||
    m.includes('api key') ||
    m.includes('token') ||
    m.includes('password') ||
    m.includes('senha')
  );
}

function isShortAffirmative(message: string) {
  const t = message.trim().toLowerCase();
  return t === 'sim' || t === 'ok' || t === 'claro' || t === 'pode ser' || t === 'vamos';
}

function isShortMore(message: string) {
  const t = message.trim().toLowerCase();
  return t === 'mais' || t === 'mostra mais' || t === 'mais info' || t === 'detalhes' || t === 'detalhe';
}

function detectIntent(message: string, prev?: ConversationState | null): ChatIntent {
  if (isSensitiveRequest(message)) return 'sensitive';

  if (parseFeedbackAction(message)) return 'feedback';
  if (inferPrefsFromMessage(message)) return 'prefs';

  const m = message.toLowerCase();
  if (m.includes('alerta') || m.includes('notifica')) return 'alerts';
  if (m.includes('compar') || m.includes('vizin') || m.includes('semelh')) return 'compare_peers';
  if (m.includes('tarifa') || m.includes('bi-hor') || m.includes('tri-hor') || m.includes('mudar de tarifa') || m.includes('simular tarifa')) return 'tariff_sim';
  if (m.includes('e se ') || m.startsWith('e se') || m.includes('what if')) return 'what_if';

  if (isPlan7dRequest(message)) return 'plan_7d';
  if (isExplainRequest(message)) return 'explain';

  if (isShortAffirmative(message) || isShortMore(message)) {
    if (prev?.pending?.type === 'suggest_appliance_actions') return 'appliance_actions';
    if (prev?.pending?.type === 'show_appliances_top') return 'appliances_top';
    if (prev?.pending?.type === 'show_efficiency') return 'efficiency';
    return prev?.lastIntent ?? 'help';
  }

  if (m.includes('dica') || m.includes('poupar') || m.includes('econom') || m.includes('reduz')) return 'tips';
  if (m.includes('efici') || m.includes('horária') || m.includes('horaria') || m.includes('horas') || m.includes('vazio') || m.includes('pico')) return 'efficiency';
  if (m.includes('potên') || m.includes('poten') || m.includes('kva') || m.includes('contratad')) return 'power';
  if (m.includes('equip') || m.includes('eletro') || m.includes('stand') || m.includes('dispositivo') || m.includes('aparelho')) return 'appliances_top';
  if (m.includes('mês') || m.includes('mes') || m.includes('mensal')) return 'month_to_date';
  if (m.includes('7 dias') || m.includes('semana')) return 'last_7d';
  if (m.includes('24h') || m.includes('24 h') || m.includes('ontem') || m.includes('últimas') || m.includes('ultimas')) return 'last_24h';

  return 'help';
}

async function getPeerComparison(c: Collections, customerId: string, end: Date, days = 7) {
  const customer = await c.customers.findOne(
    { id: customerId },
    { projection: { _id: 0, segment: 1, city: 1, household_size: 1 } }
  );
  if (!customer) return null;

  const seg = String((customer as any).segment ?? '');
  const city = String((customer as any).city ?? '');
  const hh = Number((customer as any).household_size ?? 0);

  const peerIds = await c.customers
    .find(
      {
        id: { $ne: customerId },
        segment: seg,
        city: city,
        household_size: hh > 0 ? { $gte: Math.max(1, hh - 1), $lte: Math.min(10, hh + 1) } : { $exists: true }
      },
      { projection: { _id: 0, id: 1 } }
    )
    .limit(25)
    .toArray();

  const ids = peerIds.map((r: any) => String(r.id)).filter(Boolean);
  if (!ids.length) return { peers: 0, yourAvgKwhDay: null, peersAvgKwhDay: null };

  const since = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const agg = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: { $in: [customerId, ...ids] }, ts: { $gte: since, $lte: end } } },
      { $group: { _id: '$customer_id', sumWatts: { $sum: '$watts' } } }
    ])
    .toArray();

  const kwhById = new Map<string, number>();
  for (const r of agg as any[]) {
    const cid = String(r?._id);
    const sumWatts = Number(r?.sumWatts ?? 0);
    const kwh = (sumWatts * 0.25) / 1000;
    kwhById.set(cid, kwh);
  }

  const your = kwhById.get(customerId);
  const peers = ids.map((id) => kwhById.get(id)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const peersAvg = peers.length ? peers.reduce((a, b) => a + b, 0) / peers.length : null;

  const yourAvgKwhDay = typeof your === 'number' ? Number((your / days).toFixed(2)) : null;
  const peersAvgKwhDay = typeof peersAvg === 'number' ? Number(((peersAvg as number) / days).toFixed(2)) : null;

  return { peers: peers.length, yourAvgKwhDay, peersAvgKwhDay };
}

function estimateMonthlySavingsForAppliance(applianceName: string, windowDays: number, windowCostEur: number) {
  const n = applianceName.toLowerCase();
  const days = Math.max(1, Math.min(60, Math.floor(windowDays || 30)));
  const monthlyCost = windowCostEur * (30 / days);

  let factor = 0.1;
  if (n.includes('stand')) factor = 0.6;
  else if (n.includes('luz') || n.includes('ilumin')) factor = 0.25;
  else if (n.includes('água quente') || n.includes('agua quente') || n.includes('termo') || n.includes('acumul')) factor = 0.18;
  else if (n.includes('ar condicionado') || n.includes('a/c') || n.includes('climat')) factor = 0.2;
  else if (n.includes('frigor') || n.includes('congel') || n.includes('arca')) factor = 0.08;
  else if (n.includes('forno') || n.includes('placa') || n.includes('fog')) factor = 0.12;
  else if (n.includes('lavar')) factor = 0.1;

  const eur = Number((Math.max(0, monthlyCost) * factor).toFixed(2));
  return eur;
}

function parseTopLimit(message: string): number | null {
  const m = message.toLowerCase();
  const mm = m.match(/\btop\s*([0-9]{1,2})\b/);
  if (mm) {
    const n = Number(mm[1]);
    if (Number.isFinite(n)) return Math.max(3, Math.min(15, Math.floor(n)));
  }
  const mm2 = m.match(/\bmostra\s*([0-9]{1,2})\b/);
  if (mm2) {
    const n = Number(mm2[1]);
    if (Number.isFinite(n)) return Math.max(3, Math.min(15, Math.floor(n)));
  }
  return null;
}

function pickApplianceActions(applianceName: string) {
  const n = applianceName.toLowerCase();

  if (n.includes('frigor') || n.includes('arca') || n.includes('congel')) {
    return [
      'Ajusta temperaturas (frigorífico ~4°C, congelador ~-18°C) e evita abrir a porta muitas vezes.',
      'Garante boa ventilação atrás/lados e verifica borrachas/vedações (fugas aumentam bastante o consumo).'
    ];
  }

  if (n.includes('termo') || n.includes('água quente') || n.includes('agua quente') || n.includes('acumul')) {
    return [
      'Define o termóstato para 55–60°C (acima disso o consumo sobe sem grande benefício).',
      'Usa um temporizador (ou rotina) para aquecer fora das horas de pico e reduzir aquecimento “em vazio”.'
    ];
  }

  if (n.includes('luz') || n.includes('ilumin')) {
    return [
      'Troca para LEDs (se ainda houver lâmpadas halógenas/incandescentes) e reduz potência onde possível.',
      'Instala sensores/temporizadores em zonas de passagem e cria hábito “último a sair apaga”.'
    ];
  }

  if (n.includes('stand') || n.includes('stand-by') || n.includes('standby')) {
    return [
      'Usa uma régua com interruptor (ou smart plug) para cortar consumos à noite em TV/boxes/consolas.',
      'Ativa modos de poupança (eco/sleep) e desliga “arranque rápido” quando não é necessário.'
    ];
  }

  if (n.includes('ar condicionado') || n.includes('a/c') || n.includes('climat')) {
    return [
      'Define setpoint moderado (verão 24–26°C / inverno 19–21°C) e usa modo “eco” quando disponível.',
      'Limpa filtros regularmente e evita ligar/desligar com muita frequência (picos aumentam custo).'
    ];
  }

  if (n.includes('forno') || n.includes('placa') || n.includes('fog')) {
    return [
      'Cozinha em lotes (uma única utilização maior) e aproveita calor residual; evita pré-aquecimentos longos.',
      'Usa tampas/panelas adequadas e, quando possível, micro-ondas/airfryer para porções pequenas.'
    ];
  }

  return [
    'Evita utilizar em simultâneo com outros grandes consumidores (reduz picos e custo).',
    'Se for uma tarefa flexível, tenta deslocar para horas mais baratas (vazio) e mede a diferença por 1 semana.'
  ];
}

async function getCustomerOrNull(c: Collections, customerId: string) {
  return c.customers.findOne(
    { id: customerId },
    {
      projection: {
        _id: 0,
        id: 1,
        name: 1,
        city: 1,
        segment: 1,
        tariff: 1,
        contracted_power_kva: 1,
        price_eur_per_kwh: 1,
        household_size: 1,
        has_solar: 1,
        ev_count: 1
      }
    }
  );
}

async function getLatestTelemetryTs(c: Collections, customerId: string) {
  const row = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  return row[0]?.ts ?? null;
}

async function sumKwhBetween(c: Collections, customerId: string, from: Date, to: Date) {
  const agg = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: from, $lte: to } } },
      { $group: { _id: null, sumWatts: { $sum: '$watts' } } }
    ])
    .toArray();

  const sumWatts = Number((agg[0] as any)?.sumWatts ?? 0);
  const kwh = wattsSamplesToKwh(sumWatts);
  return Number(kwh.toFixed(2));
}

async function getLast24hStats(c: Collections, customerId: string, end: Date) {
  const since = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const kwh = await sumKwhBetween(c, customerId, since, end);
  return { kwh };
}

async function getLastNdStats(c: Collections, customerId: string, end: Date, days: number) {
  const since = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const kwh = await sumKwhBetween(c, customerId, since, end);
  return { kwh, days };
}

function startOfUtcMonth(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
}

async function getMonthToDateStats(c: Collections, customerId: string, end: Date) {
  const start = startOfUtcMonth(end);
  const kwh = await sumKwhBetween(c, customerId, start, end);
  return { kwh, start };
}

async function getHourlyEfficiencyStats(c: Collections, customerId: string, end: Date, windowDays = 7) {
  const since = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await c.customerTelemetry15m
    .find(
      { customer_id: customerId, ts: { $gte: since, $lte: end } },
      { projection: { _id: 0, ts: 1, watts: 1 } }
    )
    .toArray();

  const dayKeys = new Set<string>();
  const byHourKwh = Array.from({ length: 24 }, () => 0);
  for (const r of rows) {
    const ts = new Date((r as any).ts);
    const hour = ts.getUTCHours();
    dayKeys.add(ts.toISOString().slice(0, 10));
    const watts = Number((r as any).watts ?? 0);
    byHourKwh[hour] += (watts * 0.25) / 1000;
  }

  const daysSeen = Math.max(1, dayKeys.size);
  const avgByHourKwh = byHourKwh.map((v) => Number((v / daysSeen).toFixed(3)));

  const customer = await c.customers.findOne({ id: customerId }, { projection: { _id: 0, tariff: 1, price_eur_per_kwh: 1 } });
  const tariff = String((customer as any)?.tariff ?? '');
  const isBi = tariff.toLowerCase().includes('bi') || tariff.toLowerCase().includes('tri');
  const offpeakHours = new Set<number>([22, 23, 0, 1, 2, 3, 4, 5, 6, 7]);
  const peakHours = new Set<number>([18, 19, 20, 21]);

  const sumTotal = avgByHourKwh.reduce((a, b) => a + b, 0);
  const sumOffpeak = avgByHourKwh.reduce((acc, v, h) => acc + (offpeakHours.has(h) ? v : 0), 0);
  const sumPeak = avgByHourKwh.reduce((acc, v, h) => acc + (peakHours.has(h) ? v : 0), 0);
  const offpeakPct = sumTotal > 0 ? sumOffpeak / sumTotal : 0;

  let scorePct = 50;
  if (isBi) {
    scorePct = Math.round(30 + 70 * offpeakPct);
  } else {
    const mean = sumTotal / 24;
    const variance = avgByHourKwh.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / 24;
    const cv = mean > 1e-9 ? Math.sqrt(variance) / mean : 1;
    scorePct = Math.round(85 - 55 * Math.min(1.2, cv));
  }
  scorePct = Math.max(0, Math.min(100, scorePct));

  const topPeakHours = Array.from({ length: 24 }, (_, h) => ({ h, v: avgByHourKwh[h] }))
    .filter(({ h }) => (isBi ? peakHours.has(h) : true))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map(({ h }) => h);

  const bestHours = Array.from({ length: 24 }, (_, h) => ({ h, v: avgByHourKwh[h] }))
    .filter(({ h }) => (isBi ? offpeakHours.has(h) : true))
    .sort((a, b) => a.v - b.v)
    .slice(0, 3)
    .map(({ h }) => h);

  const avgPrice = typeof (customer as any)?.price_eur_per_kwh === 'number' ? Number((customer as any).price_eur_per_kwh) : 0.2;
  const offpeakPrice = isBi ? avgPrice * 0.75 : avgPrice;
  const peakPrice = isBi ? avgPrice * 1.15 : avgPrice;
  const shiftKwhPerDay = isBi ? Math.min(sumPeak * 0.1, 2.0) : Math.min(sumTotal * 0.05, 1.5);
  const savePerDay = shiftKwhPerDay * Math.max(0, peakPrice - offpeakPrice);
  const savePerMonth = Number((savePerDay * 30).toFixed(2));

  return {
    scorePct,
    bestHoursUtc: bestHours,
    peakHoursUtc: topPeakHours,
    estimatedSavingsMonthEur: savePerMonth
  };
}

const COMMON_KVA = [3.45, 4.6, 5.75, 6.9, 10.35, 13.8, 17.25];

async function getPowerSuggestionQuick(c: Collections, customerId: string, end: Date, windowDays = 30) {
  const customer = await c.customers.findOne({ id: customerId }, { projection: { _id: 0, contracted_power_kva: 1, tariff: 1 } });
  const contracted = Number((customer as any)?.contracted_power_kva ?? 0);

  const since = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const peakRow = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: since, $lte: end } } },
      { $group: { _id: null, peakWatts: { $max: '$watts' } } }
    ])
    .toArray();
  const peakWatts = Number((peakRow[0] as any)?.peakWatts ?? 0);
  const peakKva = peakWatts / 1000;

  // margem de segurança simples
  const needed = peakKva * 1.15;
  let suggested = COMMON_KVA.find((x) => x >= needed) ?? Math.max(contracted, needed);
  suggested = Number(suggested.toFixed(2));

  let status: 'ok' | 'sobredimensionado' | 'subdimensionado' = 'ok';
  if (contracted > 0 && peakKva < contracted * 0.65) status = 'sobredimensionado';
  if (contracted > 0 && peakKva > contracted * 0.9) status = 'subdimensionado';

  return { contractedKva: contracted, peakKva: Number(peakKva.toFixed(2)), suggestedKva: suggested, status };
}

async function getTopAppliancesByCost(c: Collections, customerId: string, end: Date, windowDays = 30, limit = 5) {
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const lim = Math.max(3, Math.min(15, Math.floor(limit)));
  const rows = await c.customerApplianceUsage
    .aggregate([
      { $match: { customer_id: customerId, start_ts: { $gte: start, $lte: end } } },
      { $group: { _id: '$appliance_id', cost_eur: { $sum: '$cost_eur' }, energy_wh: { $sum: '$energy_wh' } } },
      { $sort: { cost_eur: -1 } },
      { $limit: lim }
    ])
    .toArray();

  const appliances = await c.appliances.find({}, { projection: { _id: 0, id: 1, name: 1 } }).toArray();
  const nameById = new Map<number, string>(appliances.map((a) => [Number(a.id), String(a.name)]));

  return (rows as any[])
    .map((r) => {
      const id = Number(r?._id);
      return {
        id,
        name: nameById.get(id) ?? `Equipamento ${id}`,
        costEur: Number(Number(r?.cost_eur ?? 0).toFixed(2)),
        energyKwh: Number((Number(r?.energy_wh ?? 0) / 1000).toFixed(2))
      };
    })
    .filter((x) => Number.isFinite(x.id));
}

async function ensureConversation(c: Collections, customerId: string, conversationId?: string) {
  const now = new Date();

  if (conversationId) {
    const existing = await c.chatConversations.findOne({ id: conversationId, customer_id: customerId }, { projection: { _id: 0, id: 1 } });
    if (existing?.id) return existing.id;
  }

  // Reusa a mais recente (se existir)
  const latest = await c.chatConversations
    .find({ customer_id: customerId }, { projection: { _id: 0, id: 1 } })
    .sort({ updated_at: -1 })
    .limit(1)
    .toArray();
  if (latest[0]?.id) return latest[0].id;

  // Cria nova
  const id = crypto.randomUUID();
  await c.chatConversations.insertOne({ id, customer_id: customerId, title: null, created_at: now, updated_at: now });
  return id;
}

async function getConversationState(c: Collections, customerId: string, conversationId: string): Promise<ConversationState | null> {
  const row = await c.chatConversations.findOne({ id: conversationId, customer_id: customerId }, { projection: { _id: 0, state: 1 } });
  const st = (row as any)?.state;
  if (!st || typeof st !== 'object') return null;
  return st as ConversationState;
}

async function setConversationState(c: Collections, customerId: string, conversationId: string, state: ConversationState) {
  await c.chatConversations.updateOne({ id: conversationId, customer_id: customerId }, { $set: { state, updated_at: new Date() } });
}

async function listConversationMessages(c: Collections, customerId: string, conversationId: string, limit: number) {
  const lim = Math.max(1, Math.min(SAFE_MAX_HISTORY, Math.floor(limit)));
  const rows = await c.chatMessages
    .find({ customer_id: customerId, conversation_id: conversationId }, { projection: { _id: 0, role: 1, content: 1, created_at: 1 } })
    .sort({ created_at: 1 })
    .limit(lim)
    .toArray();

  return rows.map((r: any) => ({
    role: (r.role as ChatMessageRole) ?? 'assistant',
    content: String(r.content ?? ''),
    createdAt: (r.created_at ? new Date(r.created_at) : new Date()).toISOString()
  }));
}

function buildFallbackReply(
  message: string,
  intent: ChatIntent,
  customer: Pick<CustomerDoc, 'name' | 'tariff' | 'contracted_power_kva' | 'price_eur_per_kwh'>,
  prevState: ConversationState | null,
  prefs: AssistantPrefs,
  context: {
    last24hKwh?: number;
    last7dKwh?: number;
    monthToDateKwh?: number;
    appliancesWindowDays?: number;
    topLimit?: number;
    followUpKind?: 'confirm' | 'more';
    topAppliances?: Array<{ name: string; costEur: number; energyKwh: number }>;
    efficiency?: { scorePct: number; bestHoursUtc: number[]; peakHoursUtc: number[]; estimatedSavingsMonthEur: number };
    power?: { contractedKva: number; peakKva: number; suggestedKva: number; status: 'ok' | 'sobredimensionado' | 'subdimensionado' };
  }
): { reply: string; cards?: ChatCard[]; actions?: ChatAction[] } {
  if (intent === 'sensitive') {
    return {
      reply: 'Não consigo ajudar com credenciais/segredos (ex.: chaves, tokens, URIs privadas). Posso ajudar a configurar variáveis de ambiente de forma segura.',
      cards: [{ kind: 'tip', title: 'Dica', detail: 'Use um ficheiro .env local e nunca comite credenciais no repositório.' }]
    };
  }

  if (intent === 'plan_7d') {
    return {
      reply:
        'Plano guiado de 7 dias (rápido e realista). Marca o que vais fazendo — eu posso ajustar conforme o teu consumo e os teus equipamentos.',
      actions: [
        {
          kind: 'plan',
          id: 'plan_7d_v1',
          title: 'Plano de poupança (7 dias)',
          items: [
            { id: 'd1_standby', label: 'Dia 1: cortar stand-by à noite', detail: 'Regletas/smart plugs em TV/box/consolas e carregadores.' },
            { id: 'd2_termo', label: 'Dia 2: ajustar termoacumulador', detail: '55–60°C e (se possível) aquecer fora do pico.' },
            { id: 'd3_lavagens', label: 'Dia 3: deslocar lavagens', detail: 'Máquina roupa/loiça para horário mais barato (se existir vazio).' },
            { id: 'd4_frio', label: 'Dia 4: otimizar frio', detail: 'Frigorífico ~4°C e congelador ~-18°C; verificar borrachas/ventilação.' },
            { id: 'd5_cozinha', label: 'Dia 5: cozinhar em lotes', detail: 'Aproveitar calor residual e evitar pré-aquecimentos longos.' },
            { id: 'd6_clima', label: 'Dia 6: setpoints moderados', detail: 'A/C 24–26°C (verão) / 19–21°C (inverno) e filtros limpos.' },
            { id: 'd7_medicao', label: 'Dia 7: medir antes/depois', detail: 'Compara 7 dias e escolhe 2 hábitos para manter.' }
          ]
        },
        { kind: 'button', id: 'why_plan', label: 'Porquê este plano?', message: 'porquê?' }
      ]
    };
  }

  const m = message.toLowerCase();
  const top = context.topAppliances?.[0];
  const appliancesDays = Number(context.appliancesWindowDays ?? 30);
  const topLimit = Math.max(3, Math.min(15, Math.floor(context.topLimit ?? (context.topAppliances?.length ?? 5) ?? 5)));

  if (intent === 'explain') {
    const last = prevState?.lastExplain;
    if (!last) {
      return {
        reply:
          'Consigo explicar o “porquê”, mas preciso de contexto. Primeiro pede um resumo (ex.: “últimas 24h”, “top equipamento”, “eficiência”), e depois pergunta “porquê?”.',
        actions: [
          { kind: 'button', id: 'q_24h', label: 'Ver 24h', message: 'Quanto gastei nas últimas 24h?' },
          { kind: 'button', id: 'q_top', label: 'Top equipamento', message: 'Qual o equipamento que mais consome?' }
        ]
      };
    }

    if (last.topic === 'appliances_top' || last.topic === 'appliance_actions') {
      const d = last.windowDays ?? appliancesDays;
      const ap = last.applianceName ? ` (ex.: “${last.applianceName}”)` : '';
      const totalCost = (context.topAppliances ?? []).reduce((acc, a) => acc + (a?.costEur ?? 0), 0);
      const topName = top?.name;
      const topCost = top?.costEur;
      const topShare =
        typeof topCost === 'number' && totalCost > 0 ? `${Math.round((topCost / totalCost) * 100)}%` : null;
      return {
        reply:
          `Eu baseio o ranking/sugestões em sessões estimadas por equipamento nos últimos ${d} dias${ap}. ` +
          (topName && typeof topCost === 'number'
            ? `Neste período, o topo é “${topName}” com ~${fmtEur(topCost)}${topShare ? ` (≈ ${topShare} do top)` : ''}. `
            : '') +
          'A lógica é: atacar primeiro onde há maior custo/kWh e onde pequenas mudanças dão mais impacto (temperatura, horários, stand-by e picos). Se quiser, eu explico como medir o “antes/depois” em 7 dias.',
        actions: [
          { kind: 'button', id: 'apply_plan', label: 'Aplicar plano 7 dias', message: ACTION_PLAN_7D },
          { kind: 'button', id: 'measure', label: 'Como medir em 7 dias?', message: 'Como medir o impacto em 7 dias?' }
        ]
      };
    }

    if (last.topic === 'efficiency') {
      const d = last.windowDays ?? 7;
      const score = context.efficiency?.scorePct;
      const best = (context.efficiency?.bestHoursUtc ?? []).slice(0, 3).map(fmtHour);
      const worst = (context.efficiency?.peakHoursUtc ?? []).slice(0, 3).map(fmtHour);
      const save = context.efficiency?.estimatedSavingsMonthEur ?? 0;
      return {
        reply:
          `Eu calculo um “score” de eficiência horária com base no padrão de consumo ao longo do dia nos últimos ${d} dias. ` +
          (typeof score === 'number' ? `O teu score atual é ${score}/100. ` : '') +
          (best.length ? `Horas mais leves: ${best.join(', ')}. ` : '') +
          (worst.length ? `Horas mais pesadas: ${worst.join(', ')}. ` : '') +
          (save > 0 ? `A poupança estimada assume deslocar consumos flexíveis (ex.: lavagens) e dá ~${fmtEur(save)}/mês. ` : '') +
          'Quando a tua tarifa tem vazio, estas trocas tendem a ter melhor retorno.',
        actions: [{ kind: 'button', id: 'apply_plan', label: 'Aplicar plano 7 dias', message: ACTION_PLAN_7D }]
      };
    }

    if (last.topic === 'power') {
      const p = context.power;
      return {
        reply:
          `Eu comparo a potência contratada (kVA) com o pico observado (kVA) e classifico: OK / sobredimensionado / perto do limite. ` +
          (p
            ? `No teu caso: contratada ${p.contractedKva.toFixed(2)} kVA, pico ~${p.peakKva.toFixed(2)} kVA, sugestão ${p.suggestedKva.toFixed(2)} kVA (${p.status}). `
            : '') +
          'A sugestão tenta evitar cortes por excesso e, ao mesmo tempo, não pagar potência a mais sem necessidade.',
        actions: [{ kind: 'button', id: 'apply_plan', label: 'Aplicar plano 7 dias', message: ACTION_PLAN_7D }]
      };
    }

    return {
      reply:
        'Eu priorizo o que tende a dar mais resultado: reduzir stand-by, reduzir picos e otimizar os maiores consumidores. Se quiser, aplico um plano guiado de 7 dias.',
      actions: [{ kind: 'button', id: 'apply_plan', label: 'Aplicar plano 7 dias', message: ACTION_PLAN_7D }]
    };
  }

  if (intent === 'appliance_actions') {
    if (top) {
      const actions = pickApplianceActions(top.name);
      const more = context.followUpKind === 'more';
      const items = more ? [...actions, 'Se quiser, digo como medir (antes/depois) e estimo poupança mensal.'] : actions;
      const saveEur = estimateMonthlySavingsForAppliance(top.name, appliancesDays, top.costEur);
      const replyBase = `Perfeito — 2 ações rápidas para “${top.name}” (últimos ${appliancesDays} dias):\n1) ${actions[0]}\n2) ${actions[1]}`;
      const replyExtra = saveEur > 0 ? `\nImpacto típico (estimado): ~${fmtEur(saveEur)}/mês (depende do teu uso).` : '';
      return {
        reply:
          prefs.style === 'short'
            ? `${replyBase}${replyExtra}`
            : `${replyBase}${replyExtra}\nSe quiseres, digo também como medir o impacto em 7 dias.`,
        cards: [
          { kind: 'metric', title: `Top equipamento (${appliancesDays}d)`, value: top.name, subtitle: `${fmtEur(top.costEur)} · ${top.energyKwh.toFixed(2)} kWh` },
          ...(saveEur > 0 ? [{ kind: 'metric', title: 'Poupança estimada', value: `${fmtEur(saveEur)}/mês`, subtitle: 'Heurística (depende do hábito)' } as ChatCard] : []),
          { kind: 'list', title: 'Ações rápidas', items }
        ],
        actions: [
          { kind: 'button', id: 'why_actions', label: 'Porquê estas ações?', message: 'porquê?' },
          { kind: 'button', id: 'apply_plan', label: 'Aplicar plano 7 dias', message: ACTION_PLAN_7D }
        ]
      };
    }

    return {
      reply: 'Consigo sugerir ações rápidas, mas ainda não tenho sessões suficientes por equipamento para identificar o maior impacto. Deixa a app recolher mais dados e tenta novamente.',
      cards: [{ kind: 'tip', title: 'Como melhorar', detail: 'Quanto mais sessões por equipamento, mais precisas ficam as sugestões.' }]
    };
  }

  if (intent === 'last_24h') {
    const kwh = context.last24hKwh;
    if (typeof kwh === 'number') {
      const cost = kwh * (customer.price_eur_per_kwh ?? 0.2);
      return {
        reply:
          prefs.style === 'short'
            ? `24h: ~${kwh.toFixed(2)} kWh (≈ ${fmtEur(cost)}).`
            : `Nas últimas 24h estimamos ~${kwh.toFixed(2)} kWh (≈ ${fmtEur(cost)}). Se quiser, digo quais os equipamentos que mais pesaram nos últimos 30 dias.`,
        cards: [
          { kind: 'metric', title: 'Energia (24h)', value: `${kwh.toFixed(2)} kWh` },
          { kind: 'metric', title: 'Custo (24h)', value: fmtEur(cost), subtitle: `Tarifa: ${String(customer.tariff ?? '—')}` }
        ],
        actions: [
          { kind: 'button', id: 'show_top', label: 'Ver top equipamentos', message: 'sim' },
          { kind: 'button', id: 'why_24h', label: 'Porquê?', message: 'porquê?' }
        ]
      };
    }
  }

  if (intent === 'last_7d') {
    const kwh = context.last7dKwh;
    if (typeof kwh === 'number') {
      const cost = kwh * (customer.price_eur_per_kwh ?? 0.2);
      return {
        reply: `Na última semana estimamos ~${kwh.toFixed(2)} kWh (≈ ${fmtEur(cost)}). Quer ver as melhores horas para deslocar consumos e poupar?`,
        cards: [
          { kind: 'metric', title: 'Energia (7 dias)', value: `${kwh.toFixed(2)} kWh` },
          { kind: 'metric', title: 'Custo (7 dias)', value: fmtEur(cost) }
        ],
        actions: [
          { kind: 'button', id: 'show_eff', label: 'Sim — melhores horas', message: 'sim' },
          { kind: 'button', id: 'why_7d', label: 'Porquê?', message: 'porquê?' }
        ]
      };
    }
  }

  if (intent === 'month_to_date') {
    const kwh = context.monthToDateKwh;
    if (typeof kwh === 'number') {
      const cost = kwh * (customer.price_eur_per_kwh ?? 0.2);
      return {
        reply: `No mês até agora estimamos ~${kwh.toFixed(2)} kWh (≈ ${fmtEur(cost)}). Se me disseres se tens bi/tri-horário, digo-te as melhores horas para tarefas flexíveis.`,
        cards: [
          { kind: 'metric', title: 'Energia (mês)', value: `${kwh.toFixed(2)} kWh` },
          { kind: 'metric', title: 'Custo (mês)', value: fmtEur(cost) }
        ],
        actions: [
          { kind: 'button', id: 'show_eff', label: 'Ver eficiência horária', message: 'sim' },
          { kind: 'button', id: 'why_mtd', label: 'Porquê?', message: 'porquê?' }
        ]
      };
    }
  }

  if (intent === 'appliances_top') {
    if (top) {
      const list = (context.topAppliances ?? []).map((a) => `${a.name}: ${fmtEur(a.costEur)} · ${a.energyKwh.toFixed(2)} kWh`);
      return {
        reply:
          prefs.style === 'short'
            ? `Top: “${top.name}” ~${fmtEur(top.costEur)} · ${top.energyKwh.toFixed(2)} kWh (${appliancesDays}d). Queres 2 ações rápidas?`
            : `Neste momento, o maior impacto estimado é “${top.name}”: ~${fmtEur(top.costEur)} e ~${top.energyKwh.toFixed(2)} kWh (últimos ${appliancesDays} dias). Quer que eu sugira 2 ações rápidas para reduzir este consumo?`,
        cards: [
          { kind: 'metric', title: `Top equipamento (${appliancesDays}d)`, value: top.name, subtitle: `${fmtEur(top.costEur)} · ${top.energyKwh.toFixed(2)} kWh` },
          ...(list.length ? [{ kind: 'list', title: `Top ${Math.min(topLimit, list.length)} (${appliancesDays}d)`, items: list, subtitle: 'Estimativa por sessões' } as ChatCard] : [])
        ],
        actions: [
          { kind: 'button', id: 'do_actions', label: 'Sim — 2 ações rápidas', message: 'sim' },
          { kind: 'button', id: 'why_top', label: 'Porquê este ranking?', message: 'porquê?' },
          { kind: 'button', id: 'apply_plan', label: 'Aplicar plano 7 dias', message: ACTION_PLAN_7D }
        ]
      };
    }
    return {
      reply: 'Ainda não tenho sessões suficientes para estimar um ranking por equipamento. Deixe a app a correr mais algum tempo e volto a tentar.',
      cards: [{ kind: 'tip', title: 'Como melhorar', detail: 'Quanto mais telemetria e sessões por equipamento, melhores ficam as estimativas.' }]
    };
  }

  if (intent === 'efficiency') {
    if (context.efficiency) {
      const best = context.efficiency.bestHoursUtc.map(fmtHour).join(', ');
      const peak = context.efficiency.peakHoursUtc.map(fmtHour).join(', ');
      return {
        reply: `Eficiência horária: ${context.efficiency.scorePct}%.
Melhores horas para consumos flexíveis: ${best || '—'}.
Horas mais pesadas: ${peak || '—'}.`,
        cards: [
          { kind: 'metric', title: 'Eficiência', value: `${context.efficiency.scorePct}%` },
          { kind: 'metric', title: 'Poupança potencial', value: `${fmtEur(context.efficiency.estimatedSavingsMonthEur)}/mês`, subtitle: 'Deslocar parte do pico para vazio' }
        ],
        actions: [
          { kind: 'button', id: 'why_eff', label: 'Porquê?', message: 'porquê?' },
          { kind: 'button', id: 'apply_plan', label: 'Aplicar plano 7 dias', message: ACTION_PLAN_7D }
        ]
      };
    }
  }

  if (intent === 'power') {
    if (context.power && context.power.contractedKva) {
      const st = context.power.status === 'sobredimensionado' ? 'Sobredimensionado' : context.power.status === 'subdimensionado' ? 'Atenção (perto do limite)' : 'OK';
      return {
        reply: `Potência: contratada ${context.power.contractedKva.toFixed(2)} kVA. Pico recente ~${context.power.peakKva.toFixed(2)} kVA.
Estado: ${st}. Sugestão rápida: ${context.power.suggestedKva.toFixed(2)} kVA.`,
        cards: [
          { kind: 'metric', title: 'Contratada', value: `${context.power.contractedKva.toFixed(2)} kVA` },
          { kind: 'metric', title: 'Pico (30d)', value: `${context.power.peakKva.toFixed(2)} kVA` },
          { kind: 'metric', title: 'Sugestão', value: `${context.power.suggestedKva.toFixed(2)} kVA`, subtitle: 'Heurística rápida' }
        ],
        actions: [
          { kind: 'button', id: 'why_power', label: 'Porquê?', message: 'porquê?' },
          { kind: 'button', id: 'apply_plan', label: 'Aplicar plano 7 dias', message: ACTION_PLAN_7D }
        ]
      };
    }
  }

  if (intent === 'tips') {
    const tips: string[] = [];
    if (context.efficiency && context.efficiency.scorePct < 65) {
      const best = context.efficiency.bestHoursUtc.map(fmtHour).join(', ');
      tips.push(`Desloca tarefas flexíveis para ${best || 'horário vazio'} (lavagens, termo, carregamentos).`);
    }
    if (top?.name?.toLowerCase().includes('stand-by')) {
      tips.push('Stand-by elevado: desliga regletas à noite e remove carregadores da ficha.');
    }
    if (!tips.length) {
      tips.push('Começa por medir 1 semana e repetir: a consistência dá as maiores poupanças.');
      tips.push('Evita picos entre 18–21h (se for bi-horário, isso costuma ser “cheia”).');
      tips.push('Define 2 metas: reduzir picos e reduzir stand-by.');
    }

    return {
      reply: `Aqui vão 3 ações rápidas:\n1) ${tips[0] ?? '—'}\n2) ${tips[1] ?? '—'}\n3) ${tips[2] ?? '—'}`,
      cards: [{ kind: 'tip', title: 'Ações rápidas', detail: 'Se quiser, eu detalho por equipamento e por horário.' }],
      actions: [
        { kind: 'button', id: 'apply_plan', label: 'Aplicar plano 7 dias', message: ACTION_PLAN_7D },
        { kind: 'button', id: 'why_tips', label: 'Porquê estas dicas?', message: 'porquê?' }
      ]
    };
  }

  return {
    reply: `Olá${customer.name ? `, ${customer.name}` : ''}! Posso ajudar com consumo, poupança e equipamentos. Experimente: “Quanto gastei nas últimas 24h?” ou “Qual o equipamento que mais consome?”`,
    cards: [
      { kind: 'metric', title: 'Potência contratada', value: `${Number(customer.contracted_power_kva ?? 0).toFixed(2)} kVA` },
      { kind: 'metric', title: 'Tarifa', value: String(customer.tariff ?? '—') }
    ],
    actions: [
      { kind: 'button', id: 'q_24h', label: '24h', message: 'Quanto gastei nas últimas 24h?' },
      { kind: 'button', id: 'q_top', label: 'Top equipamento', message: 'Qual o equipamento que mais consome?' },
      { kind: 'button', id: 'q_plan', label: 'Plano 7 dias', message: ACTION_PLAN_7D }
    ]
  };
}

export async function getCustomerChatHistory(c: Collections, customerId: string, opts?: { conversationId?: string; limit?: number }): Promise<ChatHistoryResponse> {
  const convId = opts?.conversationId;
  const limit = opts?.limit ?? 50;

  if (convId) {
    const exists = await c.chatConversations.findOne({ id: convId, customer_id: customerId }, { projection: { _id: 0, id: 1 } });
    if (!exists) return { conversationId: null, messages: [] };
    const messages = await listConversationMessages(c, customerId, convId, limit);
    return { conversationId: convId, messages };
  }

  const latest = await c.chatConversations
    .find({ customer_id: customerId }, { projection: { _id: 0, id: 1 } })
    .sort({ updated_at: -1 })
    .limit(1)
    .toArray();

  const latestId = latest[0]?.id ?? null;
  if (!latestId) return { conversationId: null, messages: [] };

  const messages = await listConversationMessages(c, customerId, latestId, limit);
  return { conversationId: latestId, messages };
}

export async function handleCustomerChat(c: Collections, customerId: string, body: unknown): Promise<{ status: number; body: ChatReplyResponse | { message: string } }> {
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { message: 'Pedido inválido (message obrigatório).' } };
  }

  const customer = await getCustomerOrNull(c, customerId);
  if (!customer) return { status: 404, body: { message: 'Cliente não encontrado' } };

  const conversationId = await ensureConversation(c, customerId, parsed.data.conversationId);

  const prevState = await getConversationState(c, customerId, conversationId);
  const intent = detectIntent(parsed.data.message, prevState);

  const prefsRow = await c.assistantPrefs.findOne({ customer_id: customerId }, { projection: { _id: 0, style: 1, focus: 1 } });
  const prefs: AssistantPrefs = {
    style: (prefsRow as any)?.style === 'short' ? 'short' : 'detailed',
    focus: (['poupanca', 'equipamentos', 'potencia', 'geral'] as const).includes((prefsRow as any)?.focus) ? ((prefsRow as any)?.focus as any) : 'geral'
  };

  const now = new Date();
  const userMsgId = crypto.randomUUID();
  await c.chatMessages.insertOne({
    id: userMsgId,
    customer_id: customerId,
    conversation_id: conversationId,
    role: 'user',
    content: parsed.data.message,
    created_at: now
  });

  // Histórico recente para o LLM (mais "conversacional")
  const recentHistory = await listConversationMessages(c, customerId, conversationId, 20).catch(() => []);

  if (intent === 'feedback') {
    const rating = parseFeedbackAction(parsed.data.message);
    if (rating) {
      const lastAssistant = await c.chatMessages
        .find({ customer_id: customerId, conversation_id: conversationId, role: 'assistant' }, { projection: { _id: 0, id: 1, content: 1, created_at: 1 } })
        .sort({ created_at: -1 })
        .limit(1)
        .toArray();

      await c.assistantFeedback.insertOne({
        id: crypto.randomUUID(),
        customer_id: customerId,
        conversation_id: conversationId,
        rating,
        topic: prevState?.lastIntent ?? undefined,
        created_at: new Date()
      });

      const reply = rating === 'up' ? 'Boa — obrigado! Vou manter este estilo.' : 'Percebido — obrigado. Vou ajustar as próximas sugestões.';
      const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);

      return { status: 200, body: { conversationId, reply: finalReply, actions: [{ kind: 'button', id: 'plan', label: 'Plano 7 dias', message: ACTION_PLAN_7D }] } };
    }
  }

  if (intent === 'prefs') {
    const update = inferPrefsFromMessage(parsed.data.message);
    if (update) {
      await c.assistantPrefs.updateOne(
        { customer_id: customerId },
        { $set: { customer_id: customerId, ...update, updated_at: new Date() } },
        { upsert: true }
      );
      const reply = `Ok — atualizado. A partir de agora respondo ${update.style === 'short' ? 'mais curto e direto' : update.style === 'detailed' ? 'com mais detalhe' : 'no estilo atual'}${update.focus ? ` (foco: ${update.focus})` : ''}.`;
      const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);
      return { status: 200, body: { conversationId, reply: finalReply } };
    }
  }

  const latestTs = await getLatestTelemetryTs(c, customerId);
  const end = latestTs ? new Date(latestTs) : null;

  const requestedWindowDays = parseWindowDays(parsed.data.message);
  const baseWindowDays = requestedWindowDays ?? prevState?.lastWindowDays ?? 7;
  const appliancesWindowDays = requestedWindowDays ?? prevState?.pending?.windowDays ?? ((intent === 'appliances_top' || intent === 'appliance_actions') ? 30 : baseWindowDays);
  const followUpKind: 'confirm' | 'more' | undefined = isShortMore(parsed.data.message) ? 'more' : isShortAffirmative(parsed.data.message) ? 'confirm' : undefined;

  const requestedTop = parseTopLimit(parsed.data.message);
  const prevTop = typeof prevState?.lastTopLimit === 'number' ? prevState.lastTopLimit : 5;
  const topLimit = requestedTop ?? (followUpKind === 'more' ? Math.min(15, prevTop + 5) : prevTop);

  // intents avançados com execução dedicada (antes de montar respostas genéricas)
  if (intent === 'alerts') {
    const cmd = parseAlertCommand(parsed.data.message);
    if (cmd) {
      const update: any = {};
      if (cmd.kind === 'spike_pct') update.spike_threshold_pct = cmd.value;
      if (cmd.kind === 'standby_watts') update.standby_threshold_watts = cmd.value;
      if (cmd.kind === 'near_power_pct') update.near_power_threshold_pct = cmd.value;
      await c.assistantPrefs.updateOne(
        { customer_id: customerId },
        { $set: { customer_id: customerId, ...update, updated_at: new Date() } },
        { upsert: true }
      );

      const reply =
        cmd.kind === 'spike_pct'
          ? `Ok — vou alertar se as últimas 24h subirem ~${cmd.value}% vs o dia anterior.`
          : cmd.kind === 'standby_watts'
            ? `Ok — vou alertar se o stand-by noturno ficar acima de ~${cmd.value} W (02:00–06:00).`
            : `Ok — vou alertar quando o pico chegar a ~${cmd.value}% da potência contratada.`;

      const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);
      return {
        status: 200,
        body: {
          conversationId,
          reply: finalReply,
          actions: [
            { kind: 'button', id: 'see_notifs', label: 'Ver notificações', message: 'Mostra notificações' },
            { kind: 'button', id: 'plan', label: 'Plano 7 dias', message: ACTION_PLAN_7D }
          ]
        }
      };
    }

    const reply =
      'Consigo configurar alertas. Exemplos: "alerta 20%" (subida 24h), "alerta standby 180w", "alerta potência 90%".';
    const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);
    return { status: 200, body: { conversationId, reply: finalReply } };
  }

  if (intent === 'tariff_sim') {
    if (!end) {
      const reply = 'Consigo simular, mas preciso de telemetria deste cliente.';
      const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);
      return { status: 200, body: { conversationId, reply: finalReply } };
    }

    const eff = await getHourlyEfficiencyStats(c, customerId, end, Math.max(7, Math.min(30, baseWindowDays))).catch(() => null);
    const currentTariff = String(customer.tariff ?? '').toLowerCase();
    const isBi = currentTariff.includes('bi') || currentTariff.includes('tri');
    const target = parseRequestedTariff(parsed.data.message);

    const replyParts: string[] = [];
    if (target && (target === 'bi' || target === 'tri') && isBi) replyParts.push('Já estás em bi/tri-horário.');
    if (target === 'simples' && !isBi) replyParts.push('Já estás em tarifa simples.');

    if (eff) {
      const save = eff.estimatedSavingsMonthEur;
      if (!isBi) {
        replyParts.push(
          `Simulação rápida: se mudares para bi-horário e deslocares ~10% do pico para vazio, a poupança potencial estimada é ~${fmtEur(save)}/mês.`
        );
      } else {
        replyParts.push(
          `Com o teu padrão atual, a poupança potencial por deslocar consumos flexíveis é ~${fmtEur(save)}/mês (mesmo já sendo bi/tri-horário).`
        );
      }
    } else {
      replyParts.push('Preciso de mais dados para estimar poupança por horários (eficiência horária indisponível).');
    }

    const reply = replyParts.join(' ');
    const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);

    return {
      status: 200,
      body: {
        conversationId,
        reply: finalReply,
        actions: [
          { kind: 'button', id: 'eff', label: 'Ver melhores horas', message: 'Eficiência horária' },
          { kind: 'button', id: 'plan', label: 'Plano 7 dias', message: ACTION_PLAN_7D }
        ]
      }
    };
  }

  if (intent === 'compare_peers') {
    if (!end) {
      const reply = 'Consigo comparar, mas preciso de telemetria deste cliente.';
      const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);
      return { status: 200, body: { conversationId, reply: finalReply } };
    }

    const cmp = await getPeerComparison(c, customerId, end, 7).catch(() => null);
    if (!cmp || cmp.peers <= 0 || cmp.yourAvgKwhDay == null || cmp.peersAvgKwhDay == null) {
      const reply = 'Ainda não tenho clientes suficientes “semelhantes” com telemetria para comparar (mesma cidade/segmento/tamanho de agregado).';
      const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);
      return { status: 200, body: { conversationId, reply: finalReply } };
    }

    const delta = cmp.peersAvgKwhDay > 0 ? (cmp.yourAvgKwhDay - cmp.peersAvgKwhDay) / cmp.peersAvgKwhDay : 0;
    const side = delta > 0 ? 'acima' : 'abaixo';
    const reply = `Comparação (7d) com ${cmp.peers} clientes semelhantes: tu ~${cmp.yourAvgKwhDay.toFixed(2)} kWh/dia vs semelhantes ~${cmp.peersAvgKwhDay.toFixed(2)} kWh/dia (≈ ${(Math.abs(delta) * 100).toFixed(0)}% ${side}).`;
    const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);
    return {
      status: 200,
      body: {
        conversationId,
        reply: finalReply,
        actions: [
          { kind: 'button', id: 'top', label: 'Ver top equipamentos', message: 'Qual o equipamento que mais consome?' },
          { kind: 'button', id: 'plan', label: 'Plano 7 dias', message: ACTION_PLAN_7D }
        ]
      }
    };
  }

  if (intent === 'what_if') {
    const requestedKva = parseRequestedPowerKva(parsed.data.message);
    if (requestedKva != null) {
      if (!end) {
        const reply = 'Consigo estimar risco/picos, mas preciso de telemetria deste cliente.';
        const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);
        return { status: 200, body: { conversationId, reply: finalReply } };
      }

      const power = await getPowerSuggestionQuick(c, customerId, end, 30).catch(() => null);
      if (power) {
        const risky = requestedKva < power.peakKva * 1.1;
        const reply =
          `E se mudares para ${requestedKva.toFixed(2)} kVA? Pico recente ~${power.peakKva.toFixed(2)} kVA (30d). ` +
          (risky
            ? 'Há risco de disparos/limitações em picos. Eu recomendaria manter uma margem de segurança.'
            : 'Parece viável com margem de segurança, mas confirma em 2–4 semanas de uso real.');
        const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);
        return { status: 200, body: { conversationId, reply: finalReply, actions: [{ kind: 'button', id: 'power', label: 'Analisar potência', message: 'Potência contratada' }] } };
      }
    }

    const reply =
      'Diz-me o cenário: por exemplo "E se eu mudar para bi-horário?", "E se eu baixar para 4.6 kVA?" ou "E se eu deslocar lavagens para a noite?".';
    const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);
    return { status: 200, body: { conversationId, reply: finalReply } };
  }

  const [last24h, last7d, monthToDate, topAppliances, efficiency, power] = await Promise.all([
    end ? getLast24hStats(c, customerId, end).catch(() => null) : Promise.resolve(null),
    end ? getLastNdStats(c, customerId, end, 7).catch(() => null) : Promise.resolve(null),
    end ? getMonthToDateStats(c, customerId, end).catch(() => null) : Promise.resolve(null),
    end ? getTopAppliancesByCost(c, customerId, end, Math.max(7, Math.min(60, appliancesWindowDays)), topLimit).catch(() => []) : Promise.resolve([]),
    end ? getHourlyEfficiencyStats(c, customerId, end, Math.max(3, Math.min(30, baseWindowDays))).catch(() => null) : Promise.resolve(null),
    end ? getPowerSuggestionQuick(c, customerId, end, 30).catch(() => null) : Promise.resolve(null)
  ]);

  const generated = await llmGenerateJson<z.infer<typeof LlmChatReplySchema>>({
    system:
      'És o assistente Kynex para energia residencial. Responde em português (Portugal), com foco em utilidade e clareza.\n' +
      '- O teu nome é "Kynex". Se perguntarem como te chamas, responde "Chamo-me Kynex".\n' +
      '- Responde naturalmente a saudações e small talk (ex.: "tudo bem?"), mas volta ao tema energia em 1 frase.\n' +
      '- Usa APENAS os dados fornecidos; se faltarem dados, faz 1 pergunta curta de clarificação.\n' +
      '- Nunca digas que és uma IA, nem menciones modelos.\n' +
      '- Podes devolver cards e actions para o UI quando fizer sentido, mas mantém tudo simples.\n' +
      '- Se sugerires um plano, usa um botão com message "__ACTION:PLAN_7D__".\n' +
      'Formato: {"reply":"...","cards":[...],"actions":[...]} (cards/actions opcionais).',
    user: {
      message: parsed.data.message,
      intent,
      prefs,
      state: prevState ?? null,
      history: recentHistory,
      context: {
        now: end ? end.toISOString() : null,
        last24hKwh: last24h?.kwh ?? null,
        last7dKwh: last7d?.kwh ?? null,
        monthToDateKwh: monthToDate?.kwh ?? null,
        appliancesWindowDays,
        topLimit,
        followUpKind,
        topAppliances,
        efficiency: efficiency ?? null,
        power: power ?? null
      }
    },
    schema: LlmChatReplySchema,
    mock: (u) => {
      const intentRaw = (u as any)?.intent;
      const followUpKind = (u as any)?.context?.followUpKind as 'confirm' | 'more' | undefined;
      const pendingType = (u as any)?.state?.pending?.type as string | undefined;

      if (intentRaw === 'plan_7d') {
        return {
          reply: 'Plano 7 dias pronto. Comece hoje com 2 ações simples e vá ajustando ao longo da semana.',
          actions: [
            {
              kind: 'plan',
              id: 'plan_7d',
              title: 'Plano 7 dias',
              items: [
                { id: 'd1', label: 'Cortar stand-by', detail: 'Desligue tomadas com box/TV/consolas quando não usa.' },
                { id: 'd2', label: 'Mover consumos flexíveis', detail: 'Programe lavagens fora do pico (fim da tarde).' },
                { id: 'd3', label: 'Água quente eficiente', detail: 'Evite aquecer várias vezes ao dia; concentre num período.' },
                { id: 'd4', label: 'Cozinha sem desperdício', detail: 'Use tampa e aproveite calor residual no forno/placa.' },
                { id: 'd5', label: 'Rever hábitos noturnos', detail: 'Garanta que carregadores não ficam sempre ligados.' },
                { id: 'd6', label: 'Monitorizar picos', detail: 'Evite ligar vários equipamentos de alta potência ao mesmo tempo.' },
                { id: 'd7', label: 'Revisão', detail: 'Compare 24h vs dia anterior e ajuste 1 hábito.' }
              ]
            }
          ]
        };
      }

      if (intentRaw === 'explain') {
        return {
          reply: 'Eu baseio o ranking no custo estimado e energia dos últimos dias, e comparo com padrões de utilização para destacar o que mais pesa.',
          actions: [{ kind: 'button', id: 'top', label: 'Ver top', message: 'Qual o equipamento que mais consome?' }]
        };
      }

      if (intentRaw === 'appliances_top') {
        return {
          reply: 'Aqui vai o top. Quer que eu sugira 2 ações rápidas para o equipamento #1?',
          actions: [{ kind: 'button', id: 'yes', label: 'Sim', message: 'sim' }]
        };
      }

      if (followUpKind === 'confirm' && pendingType === 'suggest_appliance_actions') {
        return {
          reply: 'Perfeito.\n1) Reduza o stand-by (tomadas/temporizador).\n2) Mova um consumo flexível para fora do pico quando possível.',
          actions: [{ kind: 'button', id: 'plan', label: 'Plano 7 dias', message: ACTION_PLAN_7D }]
        };
      }

      if (intentRaw === 'last_7d') {
        return {
          reply: 'Resumo da última semana pronto. Quer ver as melhores horas para concentrar consumos e poupar?',
          actions: [{ kind: 'button', id: 'yes', label: 'Sim', message: 'sim' }]
        };
      }

      if (followUpKind === 'confirm' && pendingType === 'show_efficiency') {
        return {
          reply: 'Eficiência horária: nas próximas mensagens posso indicar as horas mais favoráveis para agendar tarefas e evitar picos.',
          actions: []
        };
      }

      return { reply: 'Posso ajudar — diz-me se queres ver consumo, top equipamentos ou dicas de poupança.', cards: [], actions: [] };
    }
  });

  if (!generated) {
    // Não deixa o histórico "desalinhado" (user sem assistant).
    const reply =
      'Não consegui responder agora (serviço de IA indisponível ou não configurado). ' +
      'Tenta novamente em 10–20s. Se és tu a configurar: define LLM_MODE=full e OPENROUTER_API_KEY.';
    const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);
    return {
      status: 200,
      body: {
        conversationId,
        reply: finalReply,
        actions: [
          { kind: 'button', id: 'retry', label: 'Tentar de novo', message: parsed.data.message },
          { kind: 'button', id: 'plan', label: 'Plano 7 dias', message: ACTION_PLAN_7D }
        ]
      }
    };
  }

  const reply = generated.reply;
  const cards = generated.cards as ChatCard[] | undefined;
  const actions = generated.actions as ChatAction[] | undefined;

  const finalReply = await persistAssistantMessage(c, customerId, conversationId, reply);

  const nextState: ConversationState = {
    lastIntent: intent,
    lastWindowDays: baseWindowDays,
    lastTopLimit: topLimit
  };

  const top = Array.isArray(topAppliances) ? topAppliances[0] : undefined;
  if (intent === 'appliances_top' && top?.name) nextState.lastExplain = { topic: 'appliances_top', windowDays: appliancesWindowDays, applianceName: top.name };
  if (intent === 'appliance_actions' && top?.name) nextState.lastExplain = { topic: 'appliance_actions', windowDays: appliancesWindowDays, applianceName: top.name };
  if (intent === 'efficiency') nextState.lastExplain = { topic: 'efficiency', windowDays: baseWindowDays };
  if (intent === 'power') nextState.lastExplain = { topic: 'power' };
  if (intent === 'tips') nextState.lastExplain = { topic: 'tips' };
  if (intent === 'last_24h') nextState.lastExplain = { topic: 'last_24h', windowDays: 1 };
  if (intent === 'last_7d') nextState.lastExplain = { topic: 'last_7d', windowDays: 7 };
  if (intent === 'month_to_date') nextState.lastExplain = { topic: 'month_to_date' };

  const hasTop = Array.isArray(topAppliances) && topAppliances.length > 0;
  if (intent === 'appliances_top' && hasTop) {
    nextState.pending = { type: 'suggest_appliance_actions', windowDays: appliancesWindowDays };
  } else if (intent === 'last_24h') {
    nextState.pending = { type: 'show_appliances_top', windowDays: 30 };
  } else if (intent === 'last_7d' || intent === 'month_to_date') {
    nextState.pending = { type: 'show_efficiency', windowDays: baseWindowDays };
  } else if (intent === 'appliance_actions') {
    // resolve o pending
    nextState.pending = undefined;
  } else {
    // qualquer outro intent limpa follow-ups antigos
    nextState.pending = undefined;
  }

  await setConversationState(c, customerId, conversationId, nextState);

  return {
    status: 200,
    body: {
      conversationId,
      reply: finalReply,
      cards,
      actions: actions
        ? [
            ...actions,
            { kind: 'button', id: 'fb_up', label: 'Útil', message: ACTION_FEEDBACK_UP },
            { kind: 'button', id: 'fb_down', label: 'Não ajudou', message: ACTION_FEEDBACK_DOWN }
          ]
        : [
            { kind: 'button', id: 'fb_up', label: 'Útil', message: ACTION_FEEDBACK_UP },
            { kind: 'button', id: 'fb_down', label: 'Não ajudou', message: ACTION_FEEDBACK_DOWN }
          ]
    }
  };
}
