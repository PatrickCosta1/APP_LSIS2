import crypto from 'node:crypto';
import { z } from 'zod';
import type { Collections, CustomerDoc } from './db';

export const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().min(1).optional()
});

export type ChatMessageRole = 'user' | 'assistant' | 'system';

export type ChatCard =
  | { kind: 'metric'; title: string; value: string; subtitle?: string }
  | { kind: 'tip'; title: string; detail: string }
  | { kind: 'list'; title: string; items: string[]; subtitle?: string };

export type ChatHistoryItem = { role: ChatMessageRole; content: string; createdAt: string };

export type ChatHistoryResponse = {
  conversationId: string | null;
  messages: ChatHistoryItem[];
};

export type ChatReplyResponse = {
  conversationId: string;
  reply: string;
  cards?: ChatCard[];
};

const SAFE_MAX_HISTORY = 50;

type ChatIntent =
  | 'help'
  | 'sensitive'
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
      type: 'show_efficiency';
      windowDays?: number;
    };

type ConversationState = {
  lastIntent?: ChatIntent;
  lastWindowDays?: number;
  pending?: PendingState;
};

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

  const m = message.toLowerCase();
  if (isShortAffirmative(message) || isShortMore(message)) {
    if (prev?.pending?.type === 'suggest_appliance_actions') return 'appliance_actions';
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

async function getTopAppliancesByCost(c: Collections, customerId: string, end: Date, windowDays = 30) {
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await c.customerApplianceUsage
    .aggregate([
      { $match: { customer_id: customerId, start_ts: { $gte: start, $lte: end } } },
      { $group: { _id: '$appliance_id', cost_eur: { $sum: '$cost_eur' }, energy_wh: { $sum: '$energy_wh' } } },
      { $sort: { cost_eur: -1 } },
      { $limit: 5 }
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
  context: {
    last24hKwh?: number;
    last7dKwh?: number;
    monthToDateKwh?: number;
    appliancesWindowDays?: number;
    followUpKind?: 'confirm' | 'more';
    topAppliances?: Array<{ name: string; costEur: number; energyKwh: number }>;
    efficiency?: { scorePct: number; bestHoursUtc: number[]; peakHoursUtc: number[]; estimatedSavingsMonthEur: number };
    power?: { contractedKva: number; peakKva: number; suggestedKva: number; status: 'ok' | 'sobredimensionado' | 'subdimensionado' };
  }
): { reply: string; cards?: ChatCard[] } {
  if (intent === 'sensitive') {
    return {
      reply: 'Não consigo ajudar com credenciais/segredos (ex.: chaves, tokens, URIs privadas). Posso ajudar a configurar variáveis de ambiente de forma segura.',
      cards: [{ kind: 'tip', title: 'Dica', detail: 'Use um ficheiro .env local e nunca comite credenciais no repositório.' }]
    };
  }

  const m = message.toLowerCase();
  const top = context.topAppliances?.[0];
  const appliancesDays = Number(context.appliancesWindowDays ?? 30);

  if (intent === 'appliance_actions') {
    if (top) {
      const actions = pickApplianceActions(top.name);
      const more = context.followUpKind === 'more';
      const items = more ? [...actions, 'Se quiser, digo como medir (antes/depois) e estimo poupança mensal.'] : actions;
      return {
        reply: `Perfeito — 2 ações rápidas para “${top.name}” (últimos ${appliancesDays} dias):\n1) ${actions[0]}\n2) ${actions[1]}\nSe quiseres, digo também como medir o impacto em 7 dias.`,
        cards: [
          { kind: 'metric', title: `Top equipamento (${appliancesDays}d)`, value: top.name, subtitle: `${fmtEur(top.costEur)} · ${top.energyKwh.toFixed(2)} kWh` },
          { kind: 'list', title: 'Ações rápidas', items }
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
        reply: `Nas últimas 24h estimamos ~${kwh.toFixed(2)} kWh (≈ ${fmtEur(cost)}). Se quiser, digo quais os equipamentos que mais pesaram no último mês.`,
        cards: [
          { kind: 'metric', title: 'Energia (24h)', value: `${kwh.toFixed(2)} kWh` },
          { kind: 'metric', title: 'Custo (24h)', value: fmtEur(cost), subtitle: `Tarifa: ${String(customer.tariff ?? '—')}` }
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
        ]
      };
    }
  }

  if (intent === 'appliances_top') {
    if (top) {
      const list = (context.topAppliances ?? []).map((a) => `${a.name}: ${fmtEur(a.costEur)} · ${a.energyKwh.toFixed(2)} kWh`);
      return {
        reply: `Neste momento, o maior impacto estimado é “${top.name}”: ~${fmtEur(top.costEur)} e ~${top.energyKwh.toFixed(2)} kWh (últimos ${appliancesDays} dias). Quer que eu sugira 2 ações rápidas para reduzir este consumo?`,
        cards: [
          { kind: 'metric', title: `Top equipamento (${appliancesDays}d)`, value: top.name, subtitle: `${fmtEur(top.costEur)} · ${top.energyKwh.toFixed(2)} kWh` },
          ...(list.length ? [{ kind: 'list', title: `Top 5 (${appliancesDays}d)`, items: list, subtitle: 'Estimativa por sessões' } as ChatCard] : [])
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
      cards: [{ kind: 'tip', title: 'Ações rápidas', detail: 'Se quiser, eu detalho por equipamento e por horário.' }]
    };
  }

  return {
    reply: `Olá${customer.name ? `, ${customer.name}` : ''}! Posso ajudar com consumo, poupança e equipamentos. Experimente: “Quanto gastei nas últimas 24h?” ou “Qual o equipamento que mais consome?”`,
    cards: [
      { kind: 'metric', title: 'Potência contratada', value: `${Number(customer.contracted_power_kva ?? 0).toFixed(2)} kVA` },
      { kind: 'metric', title: 'Tarifa', value: String(customer.tariff ?? '—') }
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

  const latestTs = await getLatestTelemetryTs(c, customerId);
  const end = latestTs ? new Date(latestTs) : null;

  const requestedWindowDays = parseWindowDays(parsed.data.message);
  const baseWindowDays = requestedWindowDays ?? prevState?.lastWindowDays ?? 7;
  const appliancesWindowDays = requestedWindowDays ?? prevState?.pending?.windowDays ?? ((intent === 'appliances_top' || intent === 'appliance_actions') ? 30 : baseWindowDays);
  const followUpKind: 'confirm' | 'more' | undefined = isShortMore(parsed.data.message) ? 'more' : isShortAffirmative(parsed.data.message) ? 'confirm' : undefined;

  const [last24h, last7d, monthToDate, topAppliances, efficiency, power] = await Promise.all([
    end ? getLast24hStats(c, customerId, end).catch(() => null) : Promise.resolve(null),
    end ? getLastNdStats(c, customerId, end, 7).catch(() => null) : Promise.resolve(null),
    end ? getMonthToDateStats(c, customerId, end).catch(() => null) : Promise.resolve(null),
    end ? getTopAppliancesByCost(c, customerId, end, Math.max(7, Math.min(60, appliancesWindowDays))).catch(() => []) : Promise.resolve([]),
    end ? getHourlyEfficiencyStats(c, customerId, end, Math.max(3, Math.min(30, baseWindowDays))).catch(() => null) : Promise.resolve(null),
    end ? getPowerSuggestionQuick(c, customerId, end, 30).catch(() => null) : Promise.resolve(null)
  ]);

  const { reply, cards } = buildFallbackReply(parsed.data.message, intent, customer, {
    last24hKwh: last24h?.kwh,
    last7dKwh: last7d?.kwh,
    monthToDateKwh: monthToDate?.kwh,
    appliancesWindowDays,
    followUpKind,
    topAppliances
    ,
    efficiency: efficiency ?? undefined,
    power: power ?? undefined
  });

  const assistantMsgId = crypto.randomUUID();
  await c.chatMessages.insertOne({
    id: assistantMsgId,
    customer_id: customerId,
    conversation_id: conversationId,
    role: 'assistant',
    content: reply,
    created_at: new Date()
  });

  const nextState: ConversationState = {
    lastIntent: intent,
    lastWindowDays: baseWindowDays
  };

  const hasTop = Array.isArray(topAppliances) && topAppliances.length > 0;
  if (intent === 'appliances_top' && hasTop) {
    nextState.pending = { type: 'suggest_appliance_actions', windowDays: appliancesWindowDays };
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
      reply,
      cards
    }
  };
}
