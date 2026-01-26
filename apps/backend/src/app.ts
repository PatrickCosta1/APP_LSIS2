import { getIpmaDailyForecast, getIpmaTempForLocalDateTime, getIpmaWeatherTypeDescPt, resolveIpmaGlobalIdLocal } from './ipma';
import cors from 'cors';
import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getCollections, initDb, type Collections } from './db';
import { clampPredictionForCustomer, loadAiModel, makeFeatures, predictNextWatts, type CustomerProfile } from './ai';
import { clampSuggestedPowerKva, loadPowerModel, makePowerFeatures, predictRidge } from './powerAi';
import { getAiRetrainStatus, runAiRetrainOnce } from './aiTrainer';
import { getCustomerChatHistory, handleCustomerChat } from './chat';
import { hashPassword, hashToken, normalizeEmail, newToken, validatePassword, verifyPassword } from './auth';
import { getEredesNationalContext } from './openDataContext';
import { llmGenerateText, llmImproveText } from './llm/assistantText';
import { buildAssistantBaseContext, buildAssistantEnvelope } from './assistantContext';

const app = express();

app.use(cors());
app.use(express.json());

function getBearerToken(req: express.Request): string | null {
  const raw = req.header('authorization') ?? req.header('Authorization');
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

async function getSessionFromRequest(req: express.Request) {
  const token = getBearerToken(req);
  if (!token) return null;
  const cols = await collections();
  const now = new Date();
  const tokenHash = hashToken(token);
  const session = await cols.authSessions.findOne(
    { token_hash: tokenHash, expires_at: { $gt: now } },
    { projection: { _id: 0, id: 1, user_id: 1, customer_id: 1, expires_at: 1 } }
  );
  if (!session) return null;
  // best-effort last seen
  cols.authSessions.updateOne({ id: session.id }, { $set: { last_seen_at: now } }).catch(() => null);
  return { token, tokenHash, session };
}

// Protege todas as rotas /customers/:customerId/*
app.use('/customers/:customerId', async (req, res, next) => {
  const auth = await getSessionFromRequest(req);
  if (!auth) return res.status(401).json({ message: 'Não autenticado' });
  if (auth.session.customer_id !== req.params.customerId) return res.status(403).json({ message: 'Forbidden' });
  (req as any).auth = { userId: auth.session.user_id, customerId: auth.session.customer_id, sessionId: auth.session.id };
  return next();
});

app.get('/customers/:customerId/opendata/national', async (req, res) => {
  const c = await collections();
  const ctx = await getEredesNationalContext(c);
  return res.json(ctx);
});

let collectionsPromise: Promise<Collections> | null = null;
async function collections() {
  if (!collectionsPromise) {
    collectionsPromise = initDb().then(() => getCollections());
  }
  return collectionsPromise;
}

const RATE_EUR_PER_KWH = 0.2;
const SAMPLE_INTERVAL_HOURS = 0.25; // 15m dos dados sintéticos

type ChartKind = 'consumido' | 'previsto';

function isValidYmd(s: string | undefined | null): s is string {
  if (typeof s !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidYm(s: string | undefined | null): s is string {
  if (typeof s !== 'string') return false;
  return /^\d{4}-\d{2}$/.test(s);
}

function startOfUtcMonthFromYm(ym: string) {
  const [ys, ms] = ym.split('-');
  const y = Number(ys);
  const m = Number(ms);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
}

function toDayKeyUtc(d: Date) {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
}

function addUtcDays(d: Date, days: number) {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function startOfUtcMonth(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
}

function startOfNextUtcMonth(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0));
}

function startOfUtcWeekMonday(d: Date) {
  // Monday=0, Sunday=6
  const mondayIndex = (d.getUTCDay() + 6) % 7;
  return addUtcDays(startOfUtcDay(d), -mondayIndex);
}

function sumKwhFromSumWatts(sumWatts: number) {
  return (sumWatts / 1000) * SAMPLE_INTERVAL_HOURS;
}

function startOfUtcMonthFromIso(iso: string) {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
}

function daysInUtcMonthFromIso(iso: string) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  // dia 0 do mês seguinte = último dia do mês atual
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function median(values: number[]) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function stddev(values: number[]) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return 0;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (v.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/auth/me', async (req, res) => {
  const auth = await getSessionFromRequest(req);
  if (!auth) return res.status(401).json({ message: 'Não autenticado' });
  const cols = await collections();
  const user = await cols.users.findOne(
    { id: auth.session.user_id },
    { projection: { _id: 0, id: 1, email: 1, customer_id: 1, created_at: 1 } }
  );
  if (!user) return res.status(401).json({ message: 'Sessão inválida' });
  return res.json({ user: { id: user.id, email: user.email, customerId: user.customer_id, createdAt: user.created_at.toISOString() } });
});

app.post('/auth/logout', async (req, res) => {
  const auth = await getSessionFromRequest(req);
  if (!auth) return res.status(200).json({ ok: true });
  const cols = await collections();
  await cols.authSessions.deleteOne({ id: auth.session.id });
  return res.json({ ok: true });
});

app.get('/telemetry/now', async (_req, res) => {
  const c = await collections();

  const latest = await c.samples.find({}, { projection: { ts: 1, watts: 1 } }).sort({ ts: -1 }).limit(1).toArray();
  const row = latest[0];
  if (!row) return res.status(404).json({ message: 'Sem dados' });

  const eurosPerHour = (row.watts / 1000) * RATE_EUR_PER_KWH;
  const forecastMonthly = eurosPerHour * 24 * 30;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dayRows = await c.samples.find({ ts: { $gte: since } }, { projection: { watts: 1 } }).toArray();
  const costDay = dayRows.reduce(
    (acc, r) => acc + (r.watts / 1000) * RATE_EUR_PER_KWH * SAMPLE_INTERVAL_HOURS,
    0
  );

  res.json({
    watts: row.watts,
    eurosPerHour: Number(eurosPerHour.toFixed(3)),
    forecastMonthly: Number(forecastMonthly.toFixed(2)),
    costLast24h: Number(costDay.toFixed(2)),
    lastUpdated: row.ts.toISOString()
  });
});

app.get('/telemetry/day', async (_req, res) => {
  const c = await collections();
  const rows = await c.samples.find({}, { projection: { ts: 1, watts: 1 } }).sort({ ts: 1 }).limit(96).toArray();
  res.json(rows.map((r) => ({ ts: r.ts.toISOString(), watts: r.watts })));
});

app.get('/telemetry/range', async (req, res) => {
  const c = await collections();

  const { from, to, bucket = '15m' } = req.query as { from?: string; to?: string; bucket?: string };
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return res.status(400).json({ message: 'from/to inválidos' });
  }

  const coll = bucket === '15m' ? c.telemetry15m : c.samples;
  const rows = await coll
    .find({ ts: { $gte: start, $lte: end } }, { projection: { ts: 1, watts: 1, euros: 1 } })
    .sort({ ts: 1 })
    .toArray();

  return res.json(rows.map((r) => ({ ts: r.ts.toISOString(), watts: r.watts, euros: r.euros })));
});

app.get('/telemetry/forecast', (_req, res) => {
  const now = Date.now();
  const points = Array.from({ length: 24 }).map((_, idx) => {
    const ts = new Date(now + idx * 60 * 60 * 1000).toISOString();
    const watts = 400 + Math.sin(idx / 3) * 150 + (idx > 17 ? 120 : 0);
    const eurosPerHour = (watts / 1000) * RATE_EUR_PER_KWH;
    return { ts, watts: Math.round(watts), eurosPerHour: Number(eurosPerHour.toFixed(3)) };
  });
  res.json(points);
});

const listEvents = async () => {
  const c = await collections();
  const rows = await c.nilmEvents
    .find({}, { projection: { _id: 0, id: 1, label: 1, status: 1, confidence: 1, watts: 1, duration_min: 1, created_at: 1 } })
    .sort({ created_at: -1 })
    .toArray();
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
};

app.get('/events', async (_req, res) => {
  res.json(await listEvents());
});

app.get('/nilm/events', async (_req, res) => {
  res.json(await listEvents());
});

app.post('/events/:id/confirm', async (req, res) => {
  const schema = z.object({ label: z.string().min(1).max(120) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });

  const { id } = req.params;
  const c = await collections();
  const eventId = Number.parseInt(id, 10);
  if (!Number.isFinite(eventId)) return res.status(400).json({ message: 'id inválido' });

  const result = await c.nilmEvents.updateOne(
    { id: eventId },
    { $set: { label: parsed.data.label, status: 'confirmed', confidence: 0.9 } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ message: 'Evento não encontrado' });
  return res.json({ ok: true });
});

app.get('/alerts', async (_req, res) => {
  const c = await collections();
  const rows = await c.alerts
    .find({}, { projection: { _id: 0, id: 1, message: 1, severity: 1, status: 1, type: 1, created_at: 1 } })
    .sort({ created_at: -1 })
    .toArray();
  res.json(rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })));
});

app.post('/alerts/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const c = await collections();
  const alertId = Number.parseInt(id, 10);
  if (!Number.isFinite(alertId)) return res.status(400).json({ message: 'id inválido' });

  const result = await c.alerts.updateOne({ id: alertId }, { $set: { status: 'closed' } });
  if (result.matchedCount === 0) return res.status(404).json({ message: 'Alerta não encontrado' });
  return res.json({ ok: true });
});

app.get('/appliances', async (_req, res) => {
  const c = await collections();

  const appliances = await c.appliances
    .find({}, { projection: { _id: 0, id: 1, name: 1, category: 1, standby_watts: 1, efficiency_score: 1, annual_cost: 1, created_at: 1 } })
    .sort({ id: 1 })
    .toArray();

  const usage = await c.applianceUsage
    .aggregate([
      { $group: { _id: '$appliance_id', energy_wh: { $sum: '$energy_wh' }, cost_eur: { $sum: '$cost_eur' } } }
    ])
    .toArray();

  const usageMap = Object.fromEntries(usage.map((u) => [u._id, u]));

  const withUsage = appliances.map((a) => ({
    ...a,
    created_at: a.created_at.toISOString(),
    usage_wh: usageMap[a.id]?.energy_wh ?? 0,
    usage_cost: usageMap[a.id]?.cost_eur ?? 0
  }));

  res.json(withUsage);
});

app.get('/appliances/:id/usage', async (req, res) => {
  const { id } = req.params;
  const applianceId = Number.parseInt(id, 10);
  if (!Number.isFinite(applianceId)) return res.status(400).json({ message: 'id inválido' });

  const c = await collections();
  const rows = await c.applianceUsage
    .find({ appliance_id: applianceId }, { projection: { _id: 0, start_ts: 1, end_ts: 1, energy_wh: 1, cost_eur: 1, confidence: 1 } })
    .sort({ start_ts: -1 })
    .toArray();
  res.json(rows.map((r) => ({
    ...r,
    start_ts: r.start_ts.toISOString(),
    end_ts: r.end_ts.toISOString()
  })));
});

app.get('/advice/contract', async (_req, res) => {
  const c = await collections();
  const advice = await c.advice
     .find({}, { projection: { _id: 0, id: 1, current_power: 1, suggested_power: 1, tariff: 1, savings_per_month: 1, created_at: 1 } })
    .sort({ created_at: -1 })
    .limit(1)
    .toArray();

  const row = advice[0];
  if (!row) {
    return res.json({
      current_power: 6.9,
      suggested_power: 5.75,
      tariff: 'Simples',
      savings_per_month: 0,
      created_at: new Date().toISOString()
    });
  }

  return res.json({ ...row, created_at: row.created_at.toISOString() });
});

app.get('/contract/profile', async (_req, res) => {
  const c = await collections();
  const profile = await c.contractProfile.findOne({ _id: 1 }, { projection: { _id: 0, power_kva: 1, tariff: 1, utility: 1, updated_at: 1 } });
  if (!profile) return res.status(404).json({ message: 'Perfil contratual não definido' });
  res.json({ ...profile, updated_at: profile.updated_at.toISOString() });
});

app.post('/contract/simulate', async (req, res) => {
  const schema = z.object({ power_kva: z.number().min(1).max(20), tariff: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });

  const { power_kva, tariff } = parsed.data;
  const c = await collections();
  const current = await c.contractProfile.findOne({ _id: 1 }, { projection: { _id: 0, power_kva: 1, tariff: 1 } });
  const deltaPower = current ? current.power_kva - power_kva : 0;
  const savings = deltaPower > 0 ? deltaPower * 1.2 : 0; // simplificado
  const tariffImpact = tariff !== current?.tariff ? 3 : 0;

  res.json({
    proposed: { power_kva, tariff },
    estimated_savings_month: Number((savings + tariffImpact).toFixed(2)),
    risk: deltaPower > 2 ? 'moderate' : 'low'
  });
});

app.get('/reports/monthly', async (_req, res) => {
  const c = await collections();
  const rows = await c.telemetryDaily
    .find({}, { projection: { _id: 0, day: 1, kwh: 1, euros: 1, peak_watts: 1 } })
    .sort({ day: -1 })
    .limit(12)
    .toArray();
  res.json(rows);
});

app.get('/customers/:customerId/telemetry/now', async (req, res) => {
  const { customerId } = req.params;

  const c = await collections();

  const customer = await c.customers.findOne(
    { id: customerId },
    { projection: { _id: 0, id: 1, name: 1, segment: 1, home_area_m2: 1, price_eur_per_kwh: 1, contracted_power_kva: 1 } }
  );
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestRow = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1, watts: 1, temp_c: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  const latestDoc = latestRow[0];
  if (!latestDoc) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const latest = { ts: latestDoc.ts.toISOString(), watts: latestDoc.watts, temp_c: latestDoc.temp_c };

  // Usa o "tempo simulado" (último ts gravado). Como o gerador acelera +15m por tick,
  // o relógio real pode ficar atrás e os somatórios ficarem congelados.
  const end = new Date(latest.ts);
  const endIso = end.toISOString();
  const since24h = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const since1h = new Date(end.getTime() - 60 * 60 * 1000);

  const sum24hAgg = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: since24h, $lte: end } } },
      { $group: { _id: null, sumWatts: { $sum: '$watts' } } }
    ])
    .toArray();
  const kwhLast24h = sumKwhFromSumWatts(Number(sum24hAgg[0]?.sumWatts ?? 0));

  const monthStart = startOfUtcMonthFromIso(endIso);
  const sumMonthAgg = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: monthStart, $lte: end } } },
      { $group: { _id: null, sumWatts: { $sum: '$watts' } } }
    ])
    .toArray();
  const monthToDateKwh = sumKwhFromSumWatts(Number(sumMonthAgg[0]?.sumWatts ?? 0));

  const price = typeof customer.price_eur_per_kwh === 'number' ? customer.price_eur_per_kwh : RATE_EUR_PER_KWH;
  const eurosLast24h = kwhLast24h * price;
  const monthToDateEuros = monthToDateKwh * price;

  // Previsão mensal simples: usa a média diária do último dia e projeta para o mês.
  // (1 tick = +15 min, então isto evolui com o tempo simulado.)
  const dim = daysInUtcMonthFromIso(endIso);
  const forecastMonthKwh = kwhLast24h * dim;
  const forecastMonthEuros = forecastMonthKwh * price;

  const avg1hAgg = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: since1h, $lte: end } } },
      { $group: { _id: null, avgWatts: { $avg: '$watts' } } }
    ])
    .toArray();
  const avgWatts1h = Number(avg1hAgg[0]?.avgWatts ?? 0);

  // comparação com casas semelhantes (segmento + área aproximada)
  const areaLow = customer.home_area_m2 * 0.7;
  const areaHigh = customer.home_area_m2 * 1.3;
  const similarCustomers = await c.customers
    .find(
      {
        id: { $ne: customerId },
        segment: customer.segment,
        home_area_m2: { $gte: areaLow, $lte: areaHigh }
      },
      { projection: { _id: 0, id: 1 } }
    )
    .toArray();

  const similarIds = similarCustomers.map((sc) => sc.id);
  const similarRows = similarIds.length
    ? await c.customerTelemetry15m
        .aggregate([
          { $match: { customer_id: { $in: similarIds }, ts: { $gte: since24h, $lte: end } } },
          { $group: { _id: '$customer_id', sumWatts: { $sum: '$watts' } } }
        ])
        .toArray()
    : [];

  let similarKwhLast24h = 0;
  if (similarRows.length) {
    const kwhs = similarRows.map((r) => sumKwhFromSumWatts(r.sumWatts ?? 0));
    similarKwhLast24h = kwhs.reduce((a, b) => a + b, 0) / kwhs.length;
  } else {
    similarKwhLast24h = kwhLast24h * 1.15;
  }
  const similarDeltaPct = similarKwhLast24h > 0 ? ((kwhLast24h / similarKwhLast24h) - 1) * 100 : 0;

  const contractedPowerKva =
    typeof (customer as any).contracted_power_kva === 'number' && Number.isFinite((customer as any).contracted_power_kva)
      ? Number((customer as any).contracted_power_kva)
      : 6.9;

  return res.json({
    customerId: customer.id,
    name: customer.name,
    lastUpdated: latest.ts,
    wattsNow: latest.watts,
    avgWattsLastHour: Number(avgWatts1h.toFixed(1)),
    contractedPowerKva: Number(contractedPowerKva.toFixed(2)),
    kwhLast24h: Number(kwhLast24h.toFixed(2)),
    eurosLast24h: Number(eurosLast24h.toFixed(2)),
    monthToDateKwh: Number(monthToDateKwh.toFixed(2)),
    monthToDateEuros: Number(monthToDateEuros.toFixed(2)),
    forecastMonthKwh: Number(forecastMonthKwh.toFixed(2)),
    forecastMonthEuros: Number(forecastMonthEuros.toFixed(2)),
    similarKwhLast24h: Number(similarKwhLast24h.toFixed(2)),
    similarDeltaPct: Number(similarDeltaPct.toFixed(1)),
    priceEurPerKwh: Number(price.toFixed(4))
  });
});

app.get('/customers/:customerId/chart', async (req, res) => {
  const { customerId } = req.params;
  const range = (req.query.range as string | undefined) ?? 'dia';
  if (!['dia', 'semana', 'mes'].includes(range)) {
    return res.status(400).json({ message: 'range inválido (dia|semana|mes)' });
  }

  const c = await collections();

  const customer = (await c.customers.findOne(
    { id: customerId },
    {
      projection: {
        _id: 0,
        id: 1,
        segment: 1,
        city: 1,
        contracted_power_kva: 1,
        tariff: 1,
        home_area_m2: 1,
        household_size: 1,
        has_solar: 1,
        ev_count: 1,
        price_eur_per_kwh: 1
      }
    }
  )) as CustomerProfile | null;
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestRow = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1, watts: 1, temp_c: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  const latestDoc = latestRow[0];
  if (!latestDoc) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const latest = { ts: latestDoc.ts.toISOString(), watts: latestDoc.watts, temp_c: latestDoc.temp_c };

  // Tal como no /telemetry/now, usar o tempo simulado do último ponto.
  const now = new Date(latest.ts);

  const sumByDay = async (from: Date, to: Date) => {
    const rows = await c.customerTelemetry15m
      .aggregate([
        { $match: { customer_id: customerId, ts: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } },
            sumWatts: { $sum: '$watts' }
          }
        }
      ])
      .toArray();
    const map = new Map<string, number>();
    for (const r of rows) map.set(String(r._id), sumKwhFromSumWatts(Number(r.sumWatts ?? 0)));
    return map;
  };

  const buildPredictedKwhByDay = (toExclusive: Date) => {
    const model = loadAiModel();
    if (!model) return new Map<string, number>();

    try {
      const featCount = makeFeatures(new Date(latest.ts), customer, latest.watts, latest.temp_c ?? undefined).length;
      if ('feature_names' in model && model.feature_names.length !== featCount) return new Map<string, number>();
    } catch {
      return new Map<string, number>();
    }

    const intervalMinutes = model.interval_minutes ?? 15;
    const intervalHours = intervalMinutes / 60;

    let ts = new Date(latest.ts);
    let lastWatts = latest.watts;
    const out = new Map<string, number>();

    // evita loops gigantes caso algo esteja errado
    const maxSteps = 31 * 96;
    let steps = 0;

    while (ts.getTime() < toExclusive.getTime() && steps < maxSteps) {
      ts = new Date(ts.getTime() + intervalMinutes * 60 * 1000);
      if (ts.getTime() >= toExclusive.getTime()) break;
      const feats = makeFeatures(ts, customer, lastWatts, latest.temp_c ?? undefined);
      const predictedRaw = predictNextWatts(model, feats);
      const predictedWatts = clampPredictionForCustomer(predictedRaw, customer);
      const predictedKwh = (predictedWatts / 1000) * intervalHours;
      const dayKey = toDayKeyUtc(ts);
      out.set(dayKey, (out.get(dayKey) ?? 0) + predictedKwh);
      lastWatts = predictedWatts;
      steps += 1;
    }

    return out;
  };

  if (range === 'dia') {
    const labels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
    const weekStart = startOfUtcWeekMonday(now);
    const weekEnd = addUtcDays(weekStart, 7);
    const actual = await sumByDay(weekStart, weekEnd);
    const predicted = buildPredictedKwhByDay(weekEnd);

    const todayKey = toDayKeyUtc(now);

    const items = labels.map((label, idx) => {
      const dayKey = toDayKeyUtc(addUtcDays(weekStart, idx));
      const kind: ChartKind = dayKey > todayKey ? 'previsto' : 'consumido';
      const value = kind === 'previsto' ? (predicted.get(dayKey) ?? 0) : (actual.get(dayKey) ?? 0);
      return { label, date: dayKey, value: Number(value.toFixed(2)), kind };
    });

    return res.json({ title: 'Consumo', items });
  }

  // restante range mantém formato anterior

  if (range === 'semana') {
    const labels = ['S1', 'S2', 'S3', 'S4'];
    const monthStart = startOfUtcMonth(now);
    const monthEnd = startOfNextUtcMonth(now);
    const actual = await sumByDay(monthStart, monthEnd);
    const predicted = buildPredictedKwhByDay(monthEnd);
    const todayKey = toDayKeyUtc(now);

    const items = labels.map((label, idx) => {
      const start = addUtcDays(monthStart, idx * 7);
      const end = addUtcDays(monthStart, (idx + 1) * 7);
      const startKey = toDayKeyUtc(start);
      const kind: ChartKind = startKey > todayKey ? 'previsto' : 'consumido';

      let sum = 0;
      for (let d = start; d.getTime() < Math.min(end.getTime(), monthEnd.getTime()); d = addUtcDays(d, 1)) {
        const k = toDayKeyUtc(d);
        sum += kind === 'previsto' ? (predicted.get(k) ?? 0) : (actual.get(k) ?? 0);
      }

      return { label, value: Number(sum.toFixed(2)), kind };
    });

    return res.json({ title: 'Consumo', items });
  }

  // mes
  const monthLabels = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const span = 6;
  const currentMonth = now.getUTCMonth();
  const startMonthIndex = (currentMonth - (span - 1) + 12) % 12;
  const labels = Array.from({ length: span }, (_, i) => monthLabels[(startMonthIndex + i) % 12]);

  const items = await Promise.all(
    labels.map(async (label, i) => {
      const offset = (span - 1) - i;
      const start = startOfUtcMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1)));
      const end = startOfNextUtcMonth(start);
      const m = await sumByDay(start, end);
      let sum = 0;
      for (const v of m.values()) sum += v;
      return { label, value: Number(sum.toFixed(2)), kind: 'consumido' as const };
    })
  );

  return res.json({ title: 'Consumo', items });
});

app.get('/customers/:customerId/dashboard/day', async (req, res) => {
  const { customerId } = req.params;
  const date = (req.query.date as string | undefined) ?? undefined;
  if (date !== undefined && !isValidYmd(date)) return res.status(400).json({ message: 'date inválida (YYYY-MM-DD)' });

  const c = await collections();

  const customer = (await c.customers.findOne(
    { id: customerId },
    {
      projection: {
        _id: 0,
        id: 1,
        name: 1,
        segment: 1,
        city: 1,
        household_size: 1,
        price_eur_per_kwh: 1
      }
    }
  )) as
    | { id: string; name: string; segment: string; city: string; household_size?: number; price_eur_per_kwh?: number }
    | null;
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestRow = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1, watts: 1, temp_c: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  const latestDoc = latestRow[0];
  if (!latestDoc) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  // usa o tempo simulado do último ponto
  const now = new Date(latestDoc.ts.toISOString());
  const todayKey = toDayKeyUtc(now);
  const dayKey = date ?? todayKey;

  const dayStartUtc = new Date(`${dayKey}T00:00:00.000Z`);
  const dayEndUtc = addUtcDays(dayStartUtc, 1);

  const price = Number.isFinite(customer.price_eur_per_kwh as number) ? Number(customer.price_eur_per_kwh) : RATE_EUR_PER_KWH;

  // consumo do dia (se futuro, prevê via modelo)
  let kwh = 0;
  let kind: 'consumido' | 'previsto' = 'consumido';

  if (dayKey > todayKey) {
    kind = 'previsto';
    const model = loadAiModel();
    if (model) {
      try {
        const intervalMinutes = model.interval_minutes ?? 15;
        const intervalHours = intervalMinutes / 60;
        const temp_c = latestDoc.temp_c ?? undefined;

        let ts = new Date(latestDoc.ts.toISOString());
        let lastWatts = latestDoc.watts;

        const toExclusive = dayEndUtc;
        const maxSteps = 31 * 96;
        let steps = 0;

        while (ts.getTime() < toExclusive.getTime() && steps < maxSteps) {
          ts = new Date(ts.getTime() + intervalMinutes * 60 * 1000);
          if (ts.getTime() >= toExclusive.getTime()) break;
          const feats = makeFeatures(ts, customer as any, lastWatts, temp_c);
          const predictedRaw = predictNextWatts(model, feats);
          const predictedWatts = clampPredictionForCustomer(predictedRaw, customer as any);
          if (toDayKeyUtc(ts) === dayKey) {
            kwh += (predictedWatts / 1000) * intervalHours;
          }
          lastWatts = predictedWatts;
          steps += 1;
        }
      } catch {
        kwh = 0;
      }
    }
  } else {
    const rows = await c.customerTelemetry15m
      .aggregate([
        { $match: { customer_id: customerId, ts: { $gte: dayStartUtc, $lt: dayEndUtc } } },
        { $group: { _id: null, sumWatts: { $sum: '$watts' } } }
      ])
      .toArray();
    const sumWatts = rows?.[0]?.sumWatts ?? 0;
    kwh = sumKwhFromSumWatts(Number(sumWatts));
  }

  const euros = kwh * price;

  // semelhantes no dia
  const similarCustomers = await c.customers
    .find(
      {
        id: { $ne: customerId },
        segment: customer.segment,
        city: customer.city,
        household_size: customer.household_size ?? 2
      },
      { projection: { _id: 0, id: 1 } }
    )
    .limit(30)
    .toArray();

  const similarIds = similarCustomers.map((sc) => sc.id);
  const similarRows = similarIds.length
    ? await c.customerTelemetry15m
        .aggregate([
          { $match: { customer_id: { $in: similarIds }, ts: { $gte: dayStartUtc, $lt: dayEndUtc } } },
          { $group: { _id: '$customer_id', sumWatts: { $sum: '$watts' } } }
        ])
        .toArray()
    : [];

  let similarKwh = 0;
  if (similarRows.length) {
    const kwhs = similarRows.map((r) => sumKwhFromSumWatts(r.sumWatts ?? 0));
    similarKwh = kwhs.reduce((a, b) => a + b, 0) / kwhs.length;
  } else {
    similarKwh = kwh * 1.15;
  }
  const similarDeltaPct = similarKwh > 0 ? ((kwh / similarKwh) - 1) * 100 : 0;

  // meteorologia (IPMA) baseada na cidade do cliente
  const globalIdLocal = await resolveIpmaGlobalIdLocal(customer.city);
  const forecast = await getIpmaDailyForecast(globalIdLocal);
  let weather: any = null;
  if (forecast?.data?.length) {
    const day = forecast.data.find((d) => d?.forecastDate === dayKey) ?? forecast.data[0];
    const idWeatherType = day?.idWeatherType;
    const descPT = await getIpmaWeatherTypeDescPt(idWeatherType);
    weather = {
      globalIdLocal: forecast.globalIdLocal,
      dataUpdate: forecast.dataUpdate ?? null,
      forecastDate: day?.forecastDate ?? dayKey,
      tMin: day?.tMin ?? null,
      tMax: day?.tMax ?? null,
      idWeatherType: idWeatherType ?? null,
      descPT
    };
  }

  return res.json({
    customerId: customer.id,
    name: customer.name,
    date: dayKey,
    kind,
    kwh: Number(kwh.toFixed(2)),
    euros: Number(euros.toFixed(2)),
    similarKwh: Number(similarKwh.toFixed(2)),
    similarDeltaPct: Number(similarDeltaPct.toFixed(1)),
    priceEurPerKwh: Number(price.toFixed(4)),
    weather
  });
});

app.get('/customers/:customerId/analytics/consumption', async (req, res) => {
  const { customerId } = req.params;
  const range = (req.query.range as string | undefined) ?? 'semana';
  if (!['semana', 'mes'].includes(range)) {
    return res.status(400).json({ message: 'range inválido (semana|mes)' });
  }

  const c = await collections();

  const customer = await c.customers.findOne({ id: customerId }, { projection: { _id: 0, id: 1 } });
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestRow = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  const latestDoc = latestRow[0];
  if (!latestDoc) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const latest = { ts: latestDoc.ts.toISOString() };
  const now = new Date(latest.ts);

  const sumByDay = async (from: Date, to: Date) => {
    const rows = await c.customerTelemetry15m
      .aggregate([
        { $match: { customer_id: customerId, ts: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } },
            sumWatts: { $sum: '$watts' }
          }
        }
      ])
      .toArray();
    const map = new Map<string, number>();
    for (const r of rows) map.set(String(r._id), sumKwhFromSumWatts(Number(r.sumWatts ?? 0)));
    return map;
  };

  if (range === 'semana') {
    const labels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
    const weekStart = startOfUtcWeekMonday(now);
    const weekEnd = addUtcDays(weekStart, 7);
    const actual = await sumByDay(weekStart, weekEnd);

    const values = labels.map((_, idx) => {
      const dayKey = toDayKeyUtc(addUtcDays(weekStart, idx));
      return Number(((actual.get(dayKey) ?? 0)).toFixed(2));
    });

    return res.json({ range: 'semana', labels, values, lastUpdated: latest.ts });
  }

  // mes: do dia 1 ao último dia do mês do "tempo simulado" (latest.ts)
  const monthStart = startOfUtcMonth(now);
  const monthEnd = startOfNextUtcMonth(now);
  const actual = await sumByDay(monthStart, monthEnd);
  const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  const labels = Array.from({ length: dim }, (_, i) => `${i + 1}`);
  const values = labels.map((_, idx) => {
    const day = addUtcDays(monthStart, idx);
    const dayKey = toDayKeyUtc(day);
    return Number(((actual.get(dayKey) ?? 0)).toFixed(2));
  });

  return res.json({ range: 'mes', labels, values, lastUpdated: latest.ts });
});

app.get('/customers/:customerId/analytics/hourly-efficiency', async (req, res) => {
  const { customerId } = req.params;
  const days = Number((req.query.days as string | undefined) ?? '7');
  const windowDays = Number.isFinite(days) && days > 0 && days <= 60 ? Math.floor(days) : 7;

  const c = await collections();

  const customer = (await c.customers.findOne(
    { id: customerId },
    {
      projection: {
        _id: 0,
        id: 1,
        segment: 1,
        city: 1,
        contracted_power_kva: 1,
        tariff: 1,
        home_area_m2: 1,
        household_size: 1,
        has_solar: 1,
        ev_count: 1,
        price_eur_per_kwh: 1
      }
    }
  )) as
    | {
        id: string;
        segment: string;
        city: string;
        contracted_power_kva: number;
        tariff: string;
        home_area_m2?: number;
        household_size?: number;
        has_solar?: number;
        ev_count?: number;
        price_eur_per_kwh?: number;
      }
    | null;
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestRow = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  const latestDoc = latestRow[0];
  if (!latestDoc) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const lastUpdated = latestDoc.ts.toISOString();
  const end = new Date(lastUpdated);
  const since = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await c.customerTelemetry15m
    .find(
      { customer_id: customerId, ts: { $gte: since, $lte: end } },
      { projection: { _id: 0, ts: 1, watts: 1 } }
    )
    .toArray();

  if (!rows.length) return res.status(404).json({ message: 'Sem dados no período' });

  const dayKeys = new Set<string>();
  const byHourKwh = Array.from({ length: 24 }, () => 0);
  const byDayKwh = new Map<string, number>();
  for (const r of rows) {
    const ts = new Date(r.ts);
    const hour = ts.getUTCHours();
    const dayKey = toDayKeyUtc(ts);
    dayKeys.add(dayKey);
    const watts = Number(r.watts ?? 0);
    // 15m -> 0.25h
    const kwh = (watts * 0.25) / 1000;
    byHourKwh[hour] += kwh;
    byDayKwh.set(dayKey, (byDayKwh.get(dayKey) ?? 0) + kwh);
  }

  const daysSeen = Math.max(1, dayKeys.size);
  const avgByHourKwh = byHourKwh.map((v) => Number((v / daysSeen).toFixed(3)));

  const tariffLower = String(customer.tariff ?? '').toLowerCase();
  const isBi = tariffLower.includes('bi');
  const isTri = tariffLower.includes('tri');
  const isTou = isBi || isTri;
  const offpeakHours = new Set<number>([22, 23, 0, 1, 2, 3, 4, 5, 6, 7]);
  const peakHours = new Set<number>([18, 19, 20, 21]);

  const sumTotal = avgByHourKwh.reduce((a, b) => a + b, 0);
  const sumOffpeak = avgByHourKwh.reduce((acc, v, h) => acc + (offpeakHours.has(h) ? v : 0), 0);
  const sumPeak = avgByHourKwh.reduce((acc, v, h) => acc + (peakHours.has(h) ? v : 0), 0);

  const offpeakPct = sumTotal > 0 ? sumOffpeak / sumTotal : 0;
  const peakPct = sumTotal > 0 ? sumPeak / sumTotal : 0;

  // tendência: compara as últimas 24h com as 24h anteriores (se houver dados)
  const startLast24h = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const startPrev24h = new Date(end.getTime() - 48 * 60 * 60 * 1000);
  let offpeakPctLast24h = offpeakPct;
  let offpeakPctPrev24h = offpeakPct;

  if (rows.length) {
    let lastTotal = 0;
    let lastOff = 0;
    let prevTotal = 0;
    let prevOff = 0;

    for (const r of rows) {
      const ts = new Date(r.ts);
      const watts = Number(r.watts ?? 0);
      const kwh = (watts * 0.25) / 1000;
      const h = ts.getUTCHours();

      if (ts >= startLast24h && ts <= end) {
        lastTotal += kwh;
        if (offpeakHours.has(h)) lastOff += kwh;
      } else if (ts >= startPrev24h && ts < startLast24h) {
        prevTotal += kwh;
        if (offpeakHours.has(h)) prevOff += kwh;
      }
    }

    if (lastTotal > 1e-9) offpeakPctLast24h = lastOff / lastTotal;
    if (prevTotal > 1e-9) offpeakPctPrev24h = prevOff / prevTotal;
  }

  const offpeakTrend = offpeakPctLast24h - offpeakPctPrev24h; // -1..+1
  const trendPoints = Math.max(-6, Math.min(6, Math.round(offpeakTrend * 30))); // aprox. -6..+6

  const maxHour = Math.max(...avgByHourKwh, 0);
  // 0..1 (1 = bem distribuído; 0 = muito concentrado numa hora)
  const flatness = sumTotal > 0 ? clamp01(1 - maxHour / sumTotal) : 0;

  const dayTotals = Array.from(byDayKwh.values());
  const meanDay = dayTotals.length ? dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length : 0;
  const varianceDay =
    dayTotals.length && meanDay > 1e-9
      ? dayTotals.reduce((acc, v) => acc + Math.pow(v - meanDay, 2), 0) / dayTotals.length
      : 0;
  const cvDay = meanDay > 1e-9 ? Math.sqrt(varianceDay) / meanDay : 1;
  // 0..1 (1 = regularidade boa; 0 = dias muito irregulares)
  const regularity = clamp01(1 - Math.min(1.5, cvDay) / 1.5);

  // Score: mistura de (time-of-use, penalização de pico, suavidade horária e regularidade diária)
  let scorePct = 50;
  const meanHour = sumTotal / 24;
  const varianceHour = meanHour > 1e-9 ? avgByHourKwh.reduce((acc, v) => acc + Math.pow(v - meanHour, 2), 0) / 24 : 0;
  const cvHour = meanHour > 1e-9 ? Math.sqrt(varianceHour) / meanHour : 1;
  const smoothness = clamp01(1 - Math.min(1.5, cvHour) / 1.5);

  if (isTou) {
    // Bi/Tri-horário: valoriza vazio e evitar ponta/pico; inclui tendência (último dia)
    const peakWeight = isTri ? 26 : 20;
    scorePct = Math.round(14 + 58 * offpeakPct + peakWeight * (1 - peakPct) + 10 * smoothness + 6 * regularity + trendPoints);
  } else {
    // Simples: valoriza suavidade e regularidade; penaliza pico e concentração
    scorePct = Math.round(22 + 38 * smoothness + 22 * regularity + 14 * (1 - peakPct) + 10 * flatness);
  }
  scorePct = Math.max(0, Math.min(100, scorePct));

  const topPeakHours = Array.from({ length: 24 }, (_, h) => ({ h, v: avgByHourKwh[h] }))
    .filter(({ h }) => (isBi ? peakHours.has(h) : true))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map(({ h }) => h);

  const bestOffpeakHours = Array.from({ length: 24 }, (_, h) => ({ h, v: avgByHourKwh[h] }))
    .filter(({ h }) => (isBi ? offpeakHours.has(h) : true))
    .sort((a, b) => a.v - b.v)
    .slice(0, 3)
    .map(({ h }) => h);

  // Estima poupança: deslocar 10% do consumo em horas de pico para horas de vazio
  const avgPrice = typeof customer.price_eur_per_kwh === 'number' ? customer.price_eur_per_kwh : RATE_EUR_PER_KWH;
  const offpeakPrice = isBi ? avgPrice * 0.75 : avgPrice;
  const peakPrice = isBi ? avgPrice * 1.15 : avgPrice;
  const shiftKwhPerDay = isBi ? Math.min(sumPeak * 0.1, 2.0) : Math.min(sumTotal * 0.05, 1.5);
  const savePerDay = shiftKwhPerDay * Math.max(0, peakPrice - offpeakPrice);
  const savePerMonth = Number((savePerDay * 30).toFixed(2));

  const model = loadAiModel();
  let forecastNext24hByHour: number[] | null = null;
  let narrative = '';

  if (model) {
    try {
      const profile: CustomerProfile = {
        id: customer.id,
        segment: customer.segment,
        city: customer.city ?? 'Porto',
        contracted_power_kva: Number(customer.contracted_power_kva ?? 6.9),
        tariff: customer.tariff,
        home_area_m2: customer.home_area_m2,
        household_size: customer.household_size,
        has_solar: customer.has_solar,
        ev_count: customer.ev_count,
        price_eur_per_kwh: customer.price_eur_per_kwh
      };

      // Usar último sample como ponto de partida
      const lastSampleRow = await c.customerTelemetry15m
        .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1, watts: 1, temp_c: 1 } })
        .sort({ ts: -1 })
        .limit(1)
        .toArray();
      const lastSample = lastSampleRow[0];
      const startTs = new Date(lastSample?.ts ?? end);
      let ts = startTs;
      let lastWatts = Number(lastSample?.watts ?? 0);
      const tempC = typeof lastSample?.temp_c === 'number' ? (lastSample.temp_c as number) : undefined;

      const byHour = Array.from({ length: 24 }, () => 0);
      const intervalMinutes = model.interval_minutes ?? 15;
      const steps = Math.round((24 * 60) / intervalMinutes);

      for (let i = 0; i < steps; i += 1) {
        ts = new Date(ts.getTime() + intervalMinutes * 60 * 1000);
        const feats = makeFeatures(ts, profile, lastWatts, tempC);
        const predictedRaw = predictNextWatts(model, feats);
        const predicted = clampPredictionForCustomer(predictedRaw, profile);
        const hour = ts.getUTCHours();
        byHour[hour] += (predicted * (intervalMinutes / 60)) / 1000;
        lastWatts = predicted;
      }

      forecastNext24hByHour = byHour.map((v) => Number(v.toFixed(3)));
    } catch {
      forecastNext24hByHour = null;
    }
  }

  if (isTou) {
    narrative = scorePct >= 78
      ? 'Ótimo: boa parte do consumo está em vazio e os picos são controlados.'
      : scorePct >= 58
        ? 'Bom, mas dá para melhorar: deslocar tarefas flexíveis para vazio pode reduzir custos.'
        : 'A otimizar: há muito consumo fora do vazio (e/ou em pico). Mover tarefas flexíveis ajuda bastante.';
  } else {
    narrative = scorePct >= 78
      ? 'Consumo bem distribuído ao longo do dia.'
      : scorePct >= 58
        ? 'Há picos em certas horas. Distribuir melhor pode reduzir custos.'
        : 'Consumo muito concentrado em poucas horas. Ajustes simples já ajudam.';
  }

  const title = scorePct >= 75 ? 'Muito bom.' : scorePct >= 55 ? 'Bom, mas melhorável.' : 'A otimizar.';

  return res.json({
    customerId,
    lastUpdated,
    days: windowDays,
    scorePct,
    title,
    note: narrative,
    estimatedSavingsMonthEur: savePerMonth,
    bestHoursUtc: bestOffpeakHours,
    peakHoursUtc: topPeakHours,
    avgKwhByHourUtc: avgByHourKwh,
    forecastNext24hKwhByHourUtc: forecastNext24hByHour
  });
});

app.get('/customers/:customerId/analytics/electrical-health', async (req, res) => {
  const { customerId } = req.params;
  const c = await collections();

  const customer = await c.customers.findOne(
    { id: customerId },
    { projection: { _id: 0, id: 1, contracted_power_kva: 1, tariff: 1 } }
  );
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestRow = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1, watts: 1, temp_c: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  const latest = latestRow[0];
  if (!latest) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const end = new Date(latest.ts);
  const since = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const rows = await c.customerTelemetry15m
    .find({ customer_id: customerId, ts: { $gte: since, $lte: end } }, { projection: { _id: 0, watts: 1 } })
    .toArray();

  const contractedKva = Number(customer.contracted_power_kva ?? 0);
  const contractedWatts = Math.max(1, contractedKva * 1000);
  const wattsNow = Number(latest.watts ?? 0);
  const powerInUseKva = wattsNow / 1000;

  const wattsSeries = rows.map((r) => Number(r.watts ?? 0)).filter((w) => Number.isFinite(w));
  const peakWatts = wattsSeries.length ? Math.max(...wattsSeries) : wattsNow;
  const avgWatts = wattsSeries.length ? wattsSeries.reduce((a, b) => a + b, 0) / wattsSeries.length : wattsNow;
  const sdWatts = stddev(wattsSeries);

  const nearLimitCount = wattsSeries.filter((w) => w >= 0.92 * contractedWatts).length;
  const peakRatio = peakWatts / contractedWatts;

  const headroomScore = clamp01(1 - peakRatio) * 70;
  const volatilityRatio = avgWatts > 0 ? sdWatts / avgWatts : 0;
  const volatilityPenalty = clamp01(volatilityRatio / 1.2) * 18;
  const nearLimitPenalty = Math.min(25, nearLimitCount * 3);
  const base = 30;
  const scoreRaw = base + headroomScore - volatilityPenalty - nearLimitPenalty;
  const healthPct = Math.round(Math.max(1, Math.min(99, scoreRaw)));

  const status = peakRatio >= 0.98 || nearLimitCount >= 3 ? 'risco' : peakRatio >= 0.9 || nearLimitCount >= 1 ? 'atencao' : 'ok';

  const warning =
    status === 'risco'
      ? 'Evite ligar equipamentos pesados ao mesmo tempo.'
      : status === 'atencao'
        ? 'Há momentos em que fica perto do limite. Distribua os consumos.'
        : null;

  let warningOut = warning;
  if (warningOut) {
    const improved = await llmImproveText({
      kind: 'electrical_health_warning',
      customer: { id: customerId, name: null, tariff: (customer as any).tariff ?? null },
      context: {
        status,
        healthPct,
        contractedPowerKva: contractedKva,
        powerInUseKva,
        peakWatts,
        nearLimitCount
      },
      draft: warningOut,
      maxTokens: 120
    });
    if (improved) warningOut = improved;
  }

  return res.json({
    customerId,
    lastUpdated: end.toISOString(),
    status,
    healthPct,
    contractedPowerKva: Number(contractedKva.toFixed(1)),
    powerInUseKva: Number(powerInUseKva.toFixed(1)),
    warning: warningOut
  });
});

type TariffType = 'Simples' | 'Bi-horário' | 'Tri-horário' | string;

const isBiTariff = (tariff: TariffType) => String(tariff ?? '').toLowerCase().includes('bi');
const isTriTariff = (tariff: TariffType) => String(tariff ?? '').toLowerCase().includes('tri');

const offpeakHoursUtc = new Set<number>([22, 23, 0, 1, 2, 3, 4, 5, 6, 7]);
const peakHoursUtc = new Set<number>([18, 19, 20, 21]);

async function getCustomerLatestTs(customerId: string) {
  const c = await collections();
  const latestRow = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  return latestRow[0]?.ts ?? null;
}

async function getLast24hKwh(customerId: string, end: Date) {
  const c = await collections();
  const since24h = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const agg = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: since24h, $lte: end } } },
      { $group: { _id: null, sumWatts: { $sum: '$watts' } } }
    ])
    .toArray();
  return sumKwhFromSumWatts(Number(agg[0]?.sumWatts ?? 0));
}

async function getAvgByHourKwh(customerId: string, end: Date, windowDays: number) {
  const c = await collections();
  const since = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await c.customerTelemetry15m
    .find({ customer_id: customerId, ts: { $gte: since, $lte: end } }, { projection: { _id: 0, ts: 1, watts: 1 } })
    .toArray();

  const dayKeys = new Set<string>();
  const byHourKwh = Array.from({ length: 24 }, () => 0);
  for (const r of rows) {
    const ts = new Date(r.ts);
    dayKeys.add(toDayKeyUtc(ts));
    const hour = ts.getUTCHours();
    byHourKwh[hour] += (Number(r.watts ?? 0) * 0.25) / 1000;
  }
  const daysSeen = Math.max(1, dayKeys.size);
  const avgByHour = byHourKwh.map((v) => v / daysSeen);

  const sumTotal = avgByHour.reduce((a, b) => a + b, 0);
  const sumOffpeak = avgByHour.reduce((acc, v, h) => acc + (offpeakHoursUtc.has(h) ? v : 0), 0);
  const sumPeak = avgByHour.reduce((acc, v, h) => acc + (peakHoursUtc.has(h) ? v : 0), 0);

  return {
    avgByHourKwhUtc: avgByHour.map((v) => Number(v.toFixed(3))),
    sumTotalKwhPerDay: sumTotal,
    sumOffpeakKwhPerDay: sumOffpeak,
    sumPeakKwhPerDay: sumPeak,
    offpeakPct: sumTotal > 0 ? sumOffpeak / sumTotal : 0
  };
}

app.get('/customers/:customerId/appliances/summary', async (req, res) => {
  const { customerId } = req.params;
  const monthRaw = (req.query.month as string | undefined) ?? null;
  const month = isValidYm(monthRaw) ? monthRaw : null;
  const days = Number((req.query.days as string | undefined) ?? '30');
  const windowDays = Number.isFinite(days) && days > 0 && days <= 120 ? Math.floor(days) : 30;

  const c = await collections();

  const customer = await c.customers.findOne(
    { id: customerId },
    { projection: { _id: 0, id: 1, name: 1, tariff: 1, contracted_power_kva: 1, utility: 1, price_eur_per_kwh: 1, fixed_daily_fee_eur: 1 } }
  );
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestTs = await getCustomerLatestTs(customerId);
  if (!latestTs) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const end = new Date(latestTs);

  const monthStart = month ? startOfUtcMonthFromYm(month) : null;
  if (month && !monthStart) return res.status(400).json({ message: 'month inválido (esperado YYYY-MM)' });
  const monthEndExclusive = monthStart ? startOfNextUtcMonth(monthStart) : null;

  const start = monthStart ?? new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const startMatch = monthStart && monthEndExclusive ? { $gte: monthStart, $lt: monthEndExclusive } : { $gte: start, $lte: end };

  const usageAgg = await c.customerApplianceUsage
    .aggregate([
      { $match: { customer_id: customerId, start_ts: startMatch } },
      {
        $group: {
          _id: '$appliance_id',
          cost_eur: { $sum: '$cost_eur' },
          energy_wh: { $sum: '$energy_wh' },
          sessions: { $sum: 1 },
          confidence: { $avg: '$confidence' }
        }
      }
    ])
    .toArray();

  const usageById = new Map<number, { cost_eur: number; energy_wh: number; sessions: number; confidence: number }>();
  for (const row of usageAgg as any[]) {
    const id = Number(row?._id);
    if (!Number.isFinite(id)) continue;
    usageById.set(id, {
      cost_eur: Number(row?.cost_eur ?? 0),
      energy_wh: Number(row?.energy_wh ?? 0),
      sessions: Number(row?.sessions ?? 0),
      confidence: Number(row?.confidence ?? 0.85)
    });
  }

  const appliances = await c.appliances
    .find({}, { projection: { _id: 0, id: 1, name: 1, category: 1, efficiency_score: 1, standby_watts: 1 } })
    .sort({ id: 1 })
    .toArray();

  const itemsRaw = appliances.map((a) => {
    const u = usageById.get(a.id) ?? { cost_eur: 0, energy_wh: 0, sessions: 0, confidence: 0.85 };
    return {
      id: a.id,
      name: a.name,
      category: a.category,
      costEur: Number(u.cost_eur.toFixed(2)),
      energyKwh: Number((u.energy_wh / 1000).toFixed(2)),
      sessions: u.sessions,
      confidence: Number(u.confidence.toFixed(2)),
      efficiencyScore: typeof a.efficiency_score === 'number' ? a.efficiency_score : null,
      standbyWatts: typeof a.standby_watts === 'number' ? a.standby_watts : null
    };
  });

  const totalCost = itemsRaw.reduce((acc, x) => acc + x.costEur, 0);

  const items = itemsRaw
    .map((x) => {
      const share = totalCost > 0 ? x.costEur / totalCost : 0;
      let status: 'Normal' | 'Atenção' | 'Anómalo' = 'Normal';
      if (x.name.toLowerCase().includes('stand-by') && share >= 0.22) status = 'Anómalo';
      else if (share >= 0.28) status = 'Atenção';
      return { ...x, sharePct: Math.round(share * 100), status };
    })
    .sort((a, b) => b.costEur - a.costEur);

  const top = items[0];
  let suggestion = 'Tudo ok — continue a acompanhar os consumos.';
  let estimatedSavingsMonthEur: number | null = null;
  if (top) {
    const n = top.name.toLowerCase();
    if (n.includes('stand-by')) suggestion = 'Stand-by está elevado: desligue tomadas/regletas à noite e retire carregadores da ficha.';
    else if (n.includes('luz')) suggestion = 'A iluminação está a pesar: use LEDs e desligue divisões sem presença.';
    else if (n.includes('ar condicionado')) suggestion = 'Ar condicionado em destaque: ajuste para 24–25°C e limpe filtros para reduzir consumo.';
    else if (n.includes('água quente') || n.includes('termo')) suggestion = 'Água quente em destaque: baixe o termostato e evite aquecer fora de horas.';
    else if (n.includes('lavar')) suggestion = 'Máquina de lavar: prefira ciclos eco e (se possível) fora das horas de pico.';

    if (n.includes('stand-by')) estimatedSavingsMonthEur = 1.2;
    else if (n.includes('luz')) estimatedSavingsMonthEur = 0.8;
    else if (n.includes('ar condicionado')) estimatedSavingsMonthEur = 2.5;
    else if (n.includes('água quente') || n.includes('termo')) estimatedSavingsMonthEur = 1.6;
    else if (n.includes('lavar')) estimatedSavingsMonthEur = 0.4;
  }

  const daysOut = month ? daysInUtcMonthFromIso(`${month}-01T00:00:00.000Z`) : windowDays;

  // melhora o texto via LLM (se disponível) mas mantém fallback heurístico
  const baseContext = await buildAssistantBaseContext(c, customer as any, {
    end,
    includeGrid: true,
    includeEnergyWindows: true,
    includeTopAppliances30d: false
  });

  const improvedSuggestion = await llmImproveText({
    kind: 'appliances_summary_suggestion',
    customer: baseContext.customer,
    context: buildAssistantEnvelope({
      base: baseContext,
      extra: {
        window: { month, days: daysOut },
        totalCostEur: Number(totalCost.toFixed(2)),
        top: top ? { id: top.id, name: top.name, costEur: top.costEur, sharePct: top.sharePct, status: top.status } : null,
        itemsTop: items.slice(0, 5).map((x) => ({ id: x.id, name: x.name, costEur: x.costEur, sharePct: x.sharePct, status: x.status })),
        estimatedSavingsMonthEur
      }
    }),
    draft: suggestion,
    maxTokens: 140
  });
  if (improvedSuggestion) suggestion = improvedSuggestion;

  return res.json({
    customerId,
    lastUpdated: end.toISOString(),
    days: daysOut,
    month,
    totalCostEur: Number(totalCost.toFixed(2)),
    items,
    suggestion,
    estimatedSavingsMonthEur
  });
});

app.get('/customers/:customerId/appliances/:applianceId/weekly', async (req, res) => {
  const { customerId, applianceId: applianceIdRaw } = req.params;
  const days = Number((req.query.days as string | undefined) ?? '7');
  const windowDays = Number.isFinite(days) && days > 0 && days <= 31 ? Math.floor(days) : 7;

  const c = await collections();

  const customer = await c.customers.findOne({ id: customerId }, { projection: { _id: 0, id: 1, tariff: 1 } });
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const applianceId = Number(applianceIdRaw);
  if (!Number.isFinite(applianceId)) return res.status(400).json({ message: 'applianceId inválido' });

  const appliance = await c.appliances.findOne(
    { id: applianceId },
    { projection: { _id: 0, id: 1, name: 1, category: 1, standby_watts: 1 } }
  );
  if (!appliance) return res.status(404).json({ message: 'Equipamento não encontrado' });

  const latestTs = await getCustomerLatestTs(customerId);
  if (!latestTs) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const end = new Date(latestTs);
  const endDay = startOfUtcDay(end);
  const toExclusive = addUtcDays(endDay, 1);
  const start = addUtcDays(toExclusive, -windowDays);

  const totalAgg = await c.customerApplianceUsage
    .aggregate([
      { $match: { customer_id: customerId, start_ts: { $gte: start, $lt: toExclusive } } },
      { $group: { _id: null, totalCostEur: { $sum: '$cost_eur' } } }
    ])
    .toArray();
  const totalCostEur = Number((totalAgg[0] as any)?.totalCostEur ?? 0);

  const dailyAgg = await c.customerApplianceUsage
    .aggregate([
      { $match: { customer_id: customerId, appliance_id: applianceId, start_ts: { $gte: start, $lt: toExclusive } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$start_ts' } },
          energyWh: { $sum: '$energy_wh' },
          costEur: { $sum: '$cost_eur' }
        }
      }
    ])
    .toArray();

  const dailyByDay = new Map<string, { energyWh: number; costEur: number }>();
  for (const row of dailyAgg as any[]) {
    const day = String(row?._id ?? '');
    if (!isValidYmd(day)) continue;
    dailyByDay.set(day, {
      energyWh: Number(row?.energyWh ?? 0),
      costEur: Number(row?.costEur ?? 0)
    });
  }

  const daily = Array.from({ length: windowDays }, (_, i) => {
    const day = toDayKeyUtc(addUtcDays(start, i));
    const v = dailyByDay.get(day) ?? { energyWh: 0, costEur: 0 };
    return {
      day,
      kwh: Number((v.energyWh / 1000).toFixed(3)),
      costEur: Number(v.costEur.toFixed(2))
    };
  });

  const thisTotalKwh = daily.reduce((acc, x) => acc + x.kwh, 0);
  const thisTotalCostEur = daily.reduce((acc, x) => acc + x.costEur, 0);
  const sharePct = totalCostEur > 0 ? (thisTotalCostEur / totalCostEur) * 100 : 0;

  // --- personalização: distribuição horária + ação concreta (dica curta) ---
  const sessions = await c.customerApplianceUsage
    .find(
      { customer_id: customerId, appliance_id: applianceId, start_ts: { $gte: start, $lt: toExclusive } },
      { projection: { _id: 0, start_ts: 1, end_ts: 1, energy_wh: 1, cost_eur: 1 } }
    )
    .toArray();

  const kwhByHour = Array.from({ length: 24 }, () => 0);

  const distributeSession = (startTs: Date, endTs: Date, energyWh: number) => {
    const startTime = startTs.getTime();
    const endTime = endTs.getTime();
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime || !Number.isFinite(energyWh) || energyWh <= 0) {
      const h = startTs.getUTCHours();
      kwhByHour[h] += Math.max(0, energyWh) / 1000;
      return;
    }

    const totalMs = endTime - startTime;
    let cursor = startTime;
    const guardEnd = endTime + 1;
    while (cursor < guardEnd) {
      const d = new Date(cursor);
      const hour = d.getUTCHours();
      const nextHour = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1, 0, 0, 0);
      const sliceEnd = Math.min(endTime, nextHour);
      const sliceMs = Math.max(0, sliceEnd - cursor);
      const frac = totalMs > 0 ? sliceMs / totalMs : 0;
      kwhByHour[hour] += (energyWh / 1000) * frac;
      if (sliceEnd === cursor) break;
      cursor = sliceEnd;
    }
  };

  for (const s of sessions as any[]) {
    const st = new Date(s.start_ts);
    const et = s.end_ts ? new Date(s.end_ts) : new Date(new Date(s.start_ts).getTime() + 15 * 60 * 1000);
    distributeSession(st, et, Number(s.energy_wh ?? 0));
  }

  const totalKwhByHour = kwhByHour.reduce((a, b) => a + b, 0);
  const tariffLower = String((customer as any).tariff ?? '').toLowerCase();
  const isTri = tariffLower.includes('tri');
  const isTou = tariffLower.includes('bi') || isTri;

  const offKwh = kwhByHour.reduce((acc, v, h) => acc + (offpeakHoursUtc.has(h) ? v : 0), 0);
  const peakKwh = kwhByHour.reduce((acc, v, h) => acc + (peakHoursUtc.has(h) ? v : 0), 0);
  const offPct = totalKwhByHour > 0 ? offKwh / totalKwhByHour : 0;
  const peakPct = totalKwhByHour > 0 ? peakKwh / totalKwhByHour : 0;

  const dominantHour = (() => {
    let bestH = 0;
    let bestV = -1;
    for (let h = 0; h < 24; h += 1) {
      const v = kwhByHour[h];
      if (v > bestV) {
        bestV = v;
        bestH = h;
      }
    }
    return bestH;
  })();

  const maxDay = daily.reduce((best, cur) => (cur.kwh > (best?.kwh ?? -1) ? cur : best), null as null | (typeof daily)[number]);
  const minDay = daily.reduce((best, cur) => (cur.kwh < (best?.kwh ?? 1e9) ? cur : best), null as null | (typeof daily)[number]);

  const nameLower = String(appliance.name ?? '').toLowerCase();
  const categoryLower = String((appliance as any).category ?? '').toLowerCase();
  const isFlexible =
    nameLower.includes('lavar') ||
    nameLower.includes('máquina') ||
    nameLower.includes('sec') ||
    nameLower.includes('loiça') ||
    nameLower.includes('carreg') ||
    categoryLower.includes('laundry');

  const standbyWatts = typeof (appliance as any).standby_watts === 'number' ? Number((appliance as any).standby_watts) : null;

  // sinal de clima: usa média diária de temperatura no período (se existir)
  const temps = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: start, $lt: toExclusive }, temp_c: { $ne: null } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } },
          avgTemp: { $avg: '$temp_c' }
        }
      }
    ])
    .toArray();

  const tempByDay = new Map<string, number>();
  for (const t of temps as any[]) {
    const k = String(t?._id ?? '');
    if (!isValidYmd(k)) continue;
    const v = Number(t?.avgTemp);
    if (!Number.isFinite(v)) continue;
    tempByDay.set(k, v);
  }

  const corrHotCold = (() => {
    // correlação simples (sinal): compara dias quentes vs frios
    const pairs = daily
      .map((d) => ({ kwh: d.kwh, temp: tempByDay.get(d.day) }))
      .filter((p) => typeof p.temp === 'number' && Number.isFinite(p.kwh)) as Array<{ kwh: number; temp: number }>;
    if (pairs.length < 4) return 0;
    const meanT = pairs.reduce((a, b) => a + b.temp, 0) / pairs.length;
    const hot = pairs.filter((p) => p.temp >= meanT);
    const cold = pairs.filter((p) => p.temp < meanT);
    const meanHot = hot.length ? hot.reduce((a, b) => a + b.kwh, 0) / hot.length : 0;
    const meanCold = cold.length ? cold.reduce((a, b) => a + b.kwh, 0) / cold.length : 0;
    return meanHot - meanCold; // >0: mais consumo em dias quentes
  })();

  // dica curta e concreta (sem “relatório”)
  const dominantInOffpeak = offpeakHoursUtc.has(dominantHour);
  const dominantInPeak = peakHoursUtc.has(dominantHour);

  let tip = 'Use o modo eco e evite deixar ligado sem necessidade.';

  // stand-by personalizado
  if (standbyWatts != null && standbyWatts >= 6 && thisTotalKwh / Math.max(1, windowDays) < 0.35) {
    tip = 'Desligue da tomada quando não estiver a usar (o stand-by está a pesar no seu caso).';
  } else if (isTou && isFlexible && !dominantInOffpeak) {
    tip = 'Agende este equipamento para o vazio (à noite) e evite o fim da tarde para pagar menos.';
  } else if (isTou && dominantInPeak) {
    tip = 'Evite usar no pico do fim da tarde; se der, adie para vazio ou reduza a intensidade.';
  } else if (nameLower.includes('ar condicionado')) {
    tip = corrHotCold > 0.05 ? 'Em dias mais quentes, feche janelas/portas e use 24–25°C para manter conforto gastando menos.' : 'Use 24–25°C e mantenha filtros limpos; evita picos sem perder conforto.';
  } else if (nameLower.includes('água quente') || nameLower.includes('termo')) {
    tip = isTou ? 'Concentre o aquecimento de água no vazio e evite reforços no fim da tarde.' : 'Concentre o aquecimento de água num período curto e evite deixar a resistência a ligar várias vezes ao dia.';
  } else if (nameLower.includes('frigor')) {
    tip = 'Evite abrir portas muitas vezes e confirme a vedação; isso reduz o consumo sem mudar hábitos.';
  } else if (nameLower.includes('luz')) {
    tip = 'Desligue divisões vazias e use LEDs; é a ação mais rápida para reduzir o seu consumo.';
  } else if (isTou && dominantInOffpeak && offPct >= 0.55) {
    tip = 'Boa prática: você já usa mais no vazio; mantenha tarefas flexíveis nesse período.';
  }

  // melhora a dica via LLM (se disponível), mantendo-a curta e sem números/relatórios
  const baseContext = await buildAssistantBaseContext(c, customer as any, {
    end,
    includeGrid: true,
    includeEnergyWindows: false,
    includeTopAppliances30d: false
  });

  const improvedTip = await llmImproveText({
    kind: 'appliance_weekly_tip',
    customer: baseContext.customer,
    context: buildAssistantEnvelope({
      base: baseContext,
      extra: {
        appliance: { id: applianceId, name: appliance.name, category: (appliance as any).category ?? null, standbyWatts },
        windowDays,
        totals: {
          totalKwh: Number(thisTotalKwh.toFixed(3)),
          totalCostEur: Number(thisTotalCostEur.toFixed(2)),
          sharePct: Number(sharePct.toFixed(1))
        },
        usage: {
          dominantHourUtc: dominantHour,
          offpeakPct: Number((offPct * 100).toFixed(0)),
          peakPct: Number((peakPct * 100).toFixed(0))
        },
        daily: daily.map((d) => ({ day: d.day, kwh: d.kwh }))
      }
    }),
    draft: tip,
    maxTokens: 120
  });
  if (improvedTip) tip = improvedTip;

  return res.json({
    customerId,
    applianceId,
    name: appliance.name,
    lastUpdated: end.toISOString(),
    days: windowDays,
    totalKwh: Number(thisTotalKwh.toFixed(3)),
    totalCostEur: Number(thisTotalCostEur.toFixed(2)),
    sharePct: Number(sharePct.toFixed(1)),
    daily,
    tip
  });
});

app.get('/customers/:customerId/chat', async (req, res) => {
  const { customerId } = req.params;
  const c = await collections();

  const customer = await c.customers.findOne({ id: customerId }, { projection: { _id: 0, id: 1 } });
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 50;

  const out = await getCustomerChatHistory(c, customerId, { conversationId, limit });
  return res.json(out);
});

app.post('/customers/:customerId/chat', async (req, res) => {
  const { customerId } = req.params;
  const c = await collections();

  const out = await handleCustomerChat(c, customerId, req.body);
  return res.status(out.status).json(out.body);
});

const defaultRatesFromAvg = (avg: number, tariff: TariffType) => {
  const price = Number.isFinite(avg) && avg > 0 ? avg : RATE_EUR_PER_KWH;
  if (isBiTariff(tariff) || isTriTariff(tariff)) {
    // aproximação realista: vazio mais barato, cheia mais cara.
    return { vazio: Number((price * 0.75).toFixed(4)), cheia: Number((price * 1.15).toFixed(4)) };
  }
  return { vazio: Number(price.toFixed(4)), cheia: Number(price.toFixed(4)) };
};

app.get('/customers/:customerId/security/kynex-node', async (req, res) => {
  const { customerId } = req.params;
  const c = await collections();

  const customer = await c.customers.findOne(
    { id: customerId },
    { projection: { _id: 0, id: 1, name: 1, tariff: 1, contracted_power_kva: 1, utility: 1, price_eur_per_kwh: 1, fixed_daily_fee_eur: 1 } }
  );
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestTs = await getCustomerLatestTs(customerId);
  if (!latestTs) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const end = new Date(latestTs);
  const since48h = new Date(end.getTime() - 48 * 60 * 60 * 1000);
  const since14d = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000);

  const sessions48h = await c.customerApplianceUsage
    .find(
      { customer_id: customerId, start_ts: { $gte: since48h, $lte: end } },
      { projection: { _id: 0, appliance_id: 1, start_ts: 1, end_ts: 1, energy_wh: 1 } }
    )
    .toArray();

  const byAppliance = new Map<number, { wh: number; lastStart: Date; lastEnd: Date; lastEnergyWh: number }>();
  for (const s of sessions48h as any[]) {
    const applianceId = Number(s?.appliance_id);
    if (!Number.isFinite(applianceId)) continue;
    const wh = Number(s?.energy_wh ?? 0);
    const startTs = new Date(s?.start_ts);
    const endTs = new Date(s?.end_ts);

    const prev = byAppliance.get(applianceId);
    const next = {
      wh: (prev?.wh ?? 0) + (Number.isFinite(wh) ? wh : 0),
      lastStart: prev?.lastStart ?? startTs,
      lastEnd: prev?.lastEnd ?? endTs,
      lastEnergyWh: prev?.lastEnergyWh ?? wh
    };

    // mantém o último evento
    if (!prev || endTs.getTime() > prev.lastEnd.getTime()) {
      next.lastStart = startTs;
      next.lastEnd = endTs;
      next.lastEnergyWh = wh;
    }

    byAppliance.set(applianceId, next);
  }

  let topIds = Array.from(byAppliance.entries())
    .sort((a, b) => (b[1]?.wh ?? 0) - (a[1]?.wh ?? 0))
    .map(([id]) => id)
    .slice(0, 3);

  if (!topIds.length) {
    // fallback: mostra alguns equipamentos "típicos" (sem depender de ter sessões já)
    const fallback = await c.appliances
      .find({ id: { $in: [2, 3, 7, 1, 6] } }, { projection: { _id: 0, id: 1 } })
      .limit(3)
      .toArray();
    topIds = fallback.map((x: any) => Number(x.id)).filter((x) => Number.isFinite(x)).slice(0, 3);
  }

  const applianceRows = await c.appliances
    .find({ id: { $in: topIds } }, { projection: { _id: 0, id: 1, name: 1, category: 1 } })
    .toArray();

  const nameById = new Map<number, { name: string; category: string }>();
  for (const a of applianceRows as any[]) {
    nameById.set(Number(a.id), { name: String(a.name ?? 'Dispositivo'), category: String(a.category ?? '') });
  }

  const devices = topIds.map((id) => {
    const meta = nameById.get(id);
    const last = byAppliance.get(id);
    const lastEnd = last?.lastEnd ? new Date(last.lastEnd) : null;
    const recentlyActive = lastEnd ? end.getTime() - lastEnd.getTime() <= 30 * 60 * 1000 : false;
    return {
      applianceId: id,
      name: meta?.name ?? `Dispositivo ${id}`,
      state: recentlyActive ? 'on' : 'off'
    };
  });

  // --- IA (heurística): deteta anomalia por duração/energia vs histórico + consumo global recente ---
  let alert: null | { title: string; message: string; severity: 'info' | 'warning' | 'critical' } = null;

  // 1) anomalia por dispositivo (sessão mais recente muito acima do padrão)
  let anomalyDevice: null | { id: number; name: string } = null;
  for (const id of topIds) {
    const last = byAppliance.get(id);
    if (!last) continue;

    const durationMin = Math.max(0, (last.lastEnd.getTime() - last.lastStart.getTime()) / (60 * 1000));
    if (durationMin < 20) continue;

    const hist = await c.customerApplianceUsage
      .find(
        { customer_id: customerId, appliance_id: id, start_ts: { $gte: since14d, $lte: end } },
        { projection: { _id: 0, start_ts: 1, end_ts: 1, energy_wh: 1 } }
      )
      .limit(400)
      .toArray();

    const durations = (hist as any[])
      .map((x) => (new Date(x.end_ts).getTime() - new Date(x.start_ts).getTime()) / (60 * 1000))
      .filter((x) => Number.isFinite(x) && x > 0);
    const energies = (hist as any[])
      .map((x) => Number(x.energy_wh ?? 0))
      .filter((x) => Number.isFinite(x) && x > 0);

    const medDur = Math.max(1, median(durations));
    const medWh = Math.max(1, median(energies));

    const longRun = durationMin >= Math.max(60, medDur * 2.2);
    const highWh = last.lastEnergyWh >= medWh * 2.0;

    if (longRun || highWh) {
      anomalyDevice = { id, name: nameById.get(id)?.name ?? `Dispositivo ${id}` };
      break;
    }
  }

  // 2) anomalia global (últimas 2h muito acima do padrão)
  const since2h = new Date(end.getTime() - 2 * 60 * 60 * 1000);
  const last2h = await c.customerTelemetry15m
    .find({ customer_id: customerId, ts: { $gte: since2h, $lte: end } }, { projection: { _id: 0, watts: 1 } })
    .toArray();
  const last2hAvg = last2h.length ? last2h.reduce((acc: number, r: any) => acc + Number(r.watts ?? 0), 0) / last2h.length : 0;

  const since7d = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const hourNow = end.getUTCHours();
  const weekRows = await c.customerTelemetry15m
    .find({ customer_id: customerId, ts: { $gte: since7d, $lte: end } }, { projection: { _id: 0, ts: 1, watts: 1 } })
    .limit(4000)
    .toArray();

  const sameHourWatts = (weekRows as any[])
    .filter((r) => new Date(r.ts).getUTCHours() === hourNow)
    .map((r) => Number(r.watts ?? 0))
    .filter((w) => Number.isFinite(w));
  const hourMedian = median(sameHourWatts);
  const globalAnomaly = hourMedian > 0 ? last2hAvg >= hourMedian * 1.85 && last2hAvg >= 900 : false;

  if (anomalyDevice || globalAnomaly) {
    const target = anomalyDevice?.name;
    alert = {
      title: 'Consumo anómalo!',
      message: target ? `Verifique o ${target}: pode ter ficado ligado.` : 'Há um pico fora do padrão. Verifique os equipamentos ligados.',
      severity: 'warning'
    };
  }

  if (alert) {
    const baseContext = await buildAssistantBaseContext(c, customer as any, {
      end,
      includeGrid: true,
      includeEnergyWindows: false,
      includeTopAppliances30d: false
    });

    const improved = await llmImproveText({
      kind: 'security_alert_message',
      customer: baseContext.customer,
      context: buildAssistantEnvelope({
        base: baseContext,
        extra: {
          lastUpdated: end.toISOString(),
          devices,
          anomalyDevice,
          globalAnomaly
        }
      }),
      draft: alert.message,
      maxTokens: 140
    });
    if (improved) alert.message = improved;
  }

  return res.json({
    customerId,
    lastUpdated: end.toISOString(),
    devices,
    alert
  });
});

app.get('/customers/:customerId/security/third-parties', async (req, res) => {
  const { customerId } = req.params;
  const c = await collections();

  const latestTs = await getCustomerLatestTs(customerId);
  const now = latestTs ? new Date(latestTs) : new Date();

  const rows = await c.customerThirdParties
    .find({ customer_id: customerId }, { projection: { _id: 0 } })
    .sort({ created_at: -1 })
    .limit(20)
    .toArray();

  const items = rows.map((r: any) => {
    const alerts = Number(r.alerts_last_48h ?? 0);
    const status = alerts >= 3 ? 'risco' : alerts >= 1 ? 'atencao' : 'normal';
    return {
      id: String(r.id),
      name: String(r.name ?? 'Terceiro'),
      status,
      alertsLast48h: alerts,
      lastActivity: (r.last_activity_at ? new Date(r.last_activity_at) : r.created_at ? new Date(r.created_at) : null)?.toISOString() ?? null
    };
  });

  return res.json({ customerId, lastUpdated: now.toISOString(), items });
});

app.post('/customers/:customerId/security/third-parties', async (req, res) => {
  const { customerId } = req.params;
  const schema = z.object({ name: z.string().min(2).max(60) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });

  const c = await collections();
  const now = new Date();
  const id = `TP_${crypto.randomUUID()}`;

  await c.customerThirdParties.insertOne({
    id,
    customer_id: customerId,
    name: parsed.data.name,
    created_at: now,
    last_activity_at: now,
    alerts_last_48h: 0
  });

  return res.status(201).json({ id });
});

app.get('/customers/:customerId/contract/analysis', async (req, res) => {
  const { customerId } = req.params;
  const c = await collections();

  const customer = (await c.customers.findOne(
    { id: customerId },
    {
      projection: {
        _id: 0,
        id: 1,
        tariff: 1,
        utility: 1,
        contracted_power_kva: 1,
        price_eur_per_kwh: 1,
        fixed_daily_fee_eur: 1
      }
    }
  )) as
    | {
        id: string;
        tariff: TariffType;
        utility: string;
        contracted_power_kva: number;
        price_eur_per_kwh: number;
        fixed_daily_fee_eur: number;
      }
    | null;
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestTs = await getCustomerLatestTs(customerId);
  if (!latestTs) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const end = new Date(latestTs);
  const endIso = end.toISOString();
  const dim = daysInUtcMonthFromIso(endIso);
  const kwhLast24h = await getLast24hKwh(customerId, end);
  const forecastMonthKwh = kwhLast24h * dim;

  const avgPrice = typeof customer.price_eur_per_kwh === 'number' ? customer.price_eur_per_kwh : RATE_EUR_PER_KWH;
  const fixedDailyFeeEur = typeof customer.fixed_daily_fee_eur === 'number' ? customer.fixed_daily_fee_eur : 0;

  const hourly = await getAvgByHourKwh(customerId, end, 7);

  const currentTariff = customer.tariff ?? 'Simples';
  const currentRates = defaultRatesFromAvg(avgPrice, currentTariff);

  const estMonthly = (tariffType: TariffType, rates: { vazio: number; cheia: number }) => {
    const isBi = isBiTariff(tariffType) || isTriTariff(tariffType);
    const offKwh = forecastMonthKwh * (isBi ? hourly.offpeakPct : 0);
    const peakKwh = forecastMonthKwh - offKwh;
    const energy = isBi ? offKwh * rates.vazio + peakKwh * rates.cheia : forecastMonthKwh * rates.cheia;
    const power = fixedDailyFeeEur * dim;
    return {
      energy: Number(energy.toFixed(2)),
      power: Number(power.toFixed(2)),
      total: Number((energy + power).toFixed(2)),
      offpeakPct: Number((hourly.offpeakPct * 100).toFixed(1))
    };
  };

  const currentCost = estMonthly(currentTariff, currentRates);

  const biRates = defaultRatesFromAvg(avgPrice, 'Bi-horário');
  const simpleRates = defaultRatesFromAvg(avgPrice, 'Simples');
  const biCost = estMonthly('Bi-horário', biRates);
  const simpleCost = estMonthly('Simples', simpleRates);

  const best = biCost.total + 0.01 < simpleCost.total ? { tariff: 'Bi-horário' as const, cost: biCost } : { tariff: 'Simples' as const, cost: simpleCost };
  const delta = Number((currentCost.total - best.cost.total).toFixed(2));

  const recommendation =
    delta > 0.5
      ? {
          tariff: best.tariff,
          message:
            best.tariff === 'Bi-horário'
              ? `O seu perfil tem ~${best.cost.offpeakPct}% do consumo em vazio. Um bi-horário pode baixar a fatura (~${delta}€/mês).`
              : `O seu consumo está pouco concentrado em vazio. Um simples tende a ser mais estável (~${delta}€/mês).`
        }
      : {
          tariff: currentTariff,
          message: 'O contrato atual já está próximo do ótimo para o seu padrão de consumo.'
        };

  const baseContext = await buildAssistantBaseContext(c, customer as any, {
    end,
    includeGrid: true,
    includeEnergyWindows: false,
    includeTopAppliances30d: false
  });

  const improvedTariffMessage = await llmImproveText({
    kind: 'contract_tariff_suggestion_message',
    customer: baseContext.customer,
    context: buildAssistantEnvelope({
      base: baseContext,
      extra: {
        forecastMonthKwh: Number(forecastMonthKwh.toFixed(1)),
        offpeakPct: Number((hourly.offpeakPct * 100).toFixed(1)),
        currentTariff,
        suggestedTariff: recommendation.tariff,
        deltaEurPerMonth: delta
      }
    }),
    draft: recommendation.message,
    maxTokens: 180
  });
  if (improvedTariffMessage) recommendation.message = improvedTariffMessage;

  return res.json({
    customerId,
    lastUpdated: endIso,
    forecastMonthKwh: Number(forecastMonthKwh.toFixed(1)),
    offpeakPct: Number((hourly.offpeakPct * 100).toFixed(1)),
    current: {
      utility: customer.utility ?? '—',
      tariff: currentTariff,
      price_vazio_eur_per_kwh: currentRates.vazio,
      price_cheia_eur_per_kwh: currentRates.cheia,
      fixed_daily_fee_eur: Number(fixedDailyFeeEur.toFixed(4)),
      estimatedMonth: currentCost
    },
    suggestion: {
      tariff: recommendation.tariff,
      message: recommendation.message,
      compare: {
        simples: { rates: simpleRates, estimatedMonth: simpleCost },
        bihorario: { rates: biRates, estimatedMonth: biCost }
      }
    }
  });
});

app.post('/customers/:customerId/contract/simulate', async (req, res) => {
  const { customerId } = req.params;
  const schema = z.object({
    tariff: z.string().min(1).max(40),
    price_vazio_eur_per_kwh: z.number().min(0.01).max(2),
    price_cheia_eur_per_kwh: z.number().min(0.01).max(2),
    fixed_daily_fee_eur: z.number().min(0).max(10)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });

  const c = await collections();
  const customer = await c.customers.findOne(
    { id: customerId },
    { projection: { _id: 0, id: 1, tariff: 1, price_eur_per_kwh: 1, fixed_daily_fee_eur: 1 } }
  );
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestTs = await getCustomerLatestTs(customerId);
  if (!latestTs) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const end = new Date(latestTs);
  const endIso = end.toISOString();
  const dim = daysInUtcMonthFromIso(endIso);
  const kwhLast24h = await getLast24hKwh(customerId, end);
  const forecastMonthKwh = kwhLast24h * dim;
  const hourly = await getAvgByHourKwh(customerId, end, 7);

  const currentTariff = (customer as any).tariff ?? 'Simples';
  const avgPrice = typeof (customer as any).price_eur_per_kwh === 'number' ? (customer as any).price_eur_per_kwh : RATE_EUR_PER_KWH;
  const currentFixed = typeof (customer as any).fixed_daily_fee_eur === 'number' ? (customer as any).fixed_daily_fee_eur : 0;
  const currentRates = defaultRatesFromAvg(avgPrice, currentTariff);

  const simulate = (tariff: TariffType, rates: { vazio: number; cheia: number }, fixedDaily: number) => {
    const isBi = isBiTariff(tariff) || isTriTariff(tariff);
    const offKwh = forecastMonthKwh * (isBi ? hourly.offpeakPct : 0);
    const peakKwh = forecastMonthKwh - offKwh;
    const energy = isBi ? offKwh * rates.vazio + peakKwh * rates.cheia : forecastMonthKwh * rates.cheia;
    const power = fixedDaily * dim;
    return {
      energy: Number(energy.toFixed(2)),
      power: Number(power.toFixed(2)),
      total: Number((energy + power).toFixed(2))
    };
  };

  const current = simulate(currentTariff, currentRates, currentFixed);
  const proposedRates = { vazio: parsed.data.price_vazio_eur_per_kwh, cheia: parsed.data.price_cheia_eur_per_kwh };
  const proposed = simulate(parsed.data.tariff, proposedRates, parsed.data.fixed_daily_fee_eur);
  const savings = Number((current.total - proposed.total).toFixed(2));

  return res.json({
    customerId,
    lastUpdated: endIso,
    forecastMonthKwh: Number(forecastMonthKwh.toFixed(1)),
    offpeakPct: Number((hourly.offpeakPct * 100).toFixed(1)),
    current: { tariff: currentTariff, rates: currentRates, fixed_daily_fee_eur: Number(currentFixed.toFixed(4)), ...current },
    proposed: {
      tariff: parsed.data.tariff,
      rates: proposedRates,
      fixed_daily_fee_eur: Number(parsed.data.fixed_daily_fee_eur.toFixed(4)),
      ...proposed
    },
    savingsMonthEur: savings
  });
});

app.get('/customers/:customerId/market/offers', async (req, res) => {
  const { customerId } = req.params;
  const baseRes = await (async () => {
    const c = await collections();
    const customer = await c.customers.findOne(
      { id: customerId },
      { projection: { _id: 0, id: 1, utility: 1, tariff: 1, price_eur_per_kwh: 1, fixed_daily_fee_eur: 1 } }
    );
    if (!customer) return null;
    const latestTs = await getCustomerLatestTs(customerId);
    if (!latestTs) return null;
    const end = new Date(latestTs);
    const endIso = end.toISOString();
    const dim = daysInUtcMonthFromIso(endIso);
    const kwhLast24h = await getLast24hKwh(customerId, end);
    const forecastMonthKwh = kwhLast24h * dim;
    const hourly = await getAvgByHourKwh(customerId, end, 7);
    const avgPrice = typeof (customer as any).price_eur_per_kwh === 'number' ? (customer as any).price_eur_per_kwh : RATE_EUR_PER_KWH;
    const currentTariff = (customer as any).tariff ?? 'Simples';
    const currentRates = defaultRatesFromAvg(avgPrice, currentTariff);
    const currentFixed = typeof (customer as any).fixed_daily_fee_eur === 'number' ? (customer as any).fixed_daily_fee_eur : 0;

    const simulate = (tariff: TariffType, rates: { vazio: number; cheia: number }, fixedDaily: number) => {
      const isBi = isBiTariff(tariff) || isTriTariff(tariff);
      const offKwh = forecastMonthKwh * (isBi ? hourly.offpeakPct : 0);
      const peakKwh = forecastMonthKwh - offKwh;
      const energy = isBi ? offKwh * rates.vazio + peakKwh * rates.cheia : forecastMonthKwh * rates.cheia;
      const power = fixedDaily * dim;
      return Number((energy + power).toFixed(2));
    };

    return {
      utility: String((customer as any).utility ?? '—'),
      lastUpdated: endIso,
      forecastMonthKwh,
      offpeakPct: hourly.offpeakPct,
      currentTariff: String(currentTariff),
      currentRates,
      currentFixed,
      currentMonthEur: simulate(currentTariff, currentRates, currentFixed)
    };
  })();

  if (!baseRes) return res.status(404).json({ message: 'Cliente/telemetria não encontrado' });

  const avg = (baseRes.currentRates.vazio + baseRes.currentRates.cheia) / 2;
  const currentMonth = baseRes.currentMonthEur;

  const providers = [
    { name: 'EDP', bias: 1.0 },
    { name: 'Endesa', bias: 0.98 },
    { name: 'Iberdrola', bias: 0.985 }
  ];

  const mkOffer = (provider: string, variant: 'Eco' | 'Flex' | 'Noite', tariff: TariffType) => {
    const base = avg * (variant === 'Eco' ? 0.94 : variant === 'Flex' ? 0.97 : 0.95);
    const rates = defaultRatesFromAvg(base, tariff);
    const fixed = Math.max(0, baseRes.currentFixed * (variant === 'Eco' ? 0.9 : variant === 'Flex' ? 1.0 : 0.95));
    return { provider, name: `${provider} ${variant}`, tariff, rates, fixed_daily_fee_eur: Number(fixed.toFixed(4)) };
  };

  const candidates = [
    mkOffer(providers[0]!.name, 'Eco', 'Simples'),
    mkOffer(providers[1]!.name, 'Flex', 'Simples'),
    mkOffer(providers[2]!.name, 'Noite', 'Bi-horário'),
    mkOffer(providers[1]!.name, 'Noite', 'Bi-horário')
  ];

  const simulateMonth = (tariff: TariffType, rates: { vazio: number; cheia: number }, fixedDaily: number) => {
    const dim = daysInUtcMonthFromIso(baseRes.lastUpdated);
    const forecastMonthKwh = baseRes.forecastMonthKwh;
    const isBi = isBiTariff(tariff) || isTriTariff(tariff);
    const offKwh = forecastMonthKwh * (isBi ? baseRes.offpeakPct : 0);
    const peakKwh = forecastMonthKwh - offKwh;
    const energy = isBi ? offKwh * rates.vazio + peakKwh * rates.cheia : forecastMonthKwh * rates.cheia;
    const power = fixedDaily * dim;
    return Number((energy + power).toFixed(2));
  };

  const offers = candidates
    .map((o) => {
      const month = simulateMonth(o.tariff, o.rates, o.fixed_daily_fee_eur);
      const savingsMonth = Number((currentMonth - month).toFixed(2));
      const savingsYear = Number((savingsMonth * 12).toFixed(2));
      const why =
        isBiTariff(o.tariff) || isTriTariff(o.tariff)
          ? `Aproveita melhor o seu consumo em vazio (~${Math.round(baseRes.offpeakPct * 100)}%).`
          : 'Preço simples e previsível ao longo do dia.';
      return {
        provider: o.provider,
        name: o.name,
        tariff: o.tariff,
        price_vazio_eur_per_kwh: o.rates.vazio,
        price_cheia_eur_per_kwh: o.rates.cheia,
        fixed_daily_fee_eur: o.fixed_daily_fee_eur,
        estimatedMonthEur: month,
        savingsMonthEur: savingsMonth,
        savingsYearEur: savingsYear,
        why
      };
    })
    .sort((a, b) => b.savingsYearEur - a.savingsYearEur)
    .slice(0, 6);

  const best = offers[0] ?? null;
  return res.json({
    customerId,
    lastUpdated: baseRes.lastUpdated,
    currentMonthEur: baseRes.currentMonthEur,
    offers,
    best
  });
});

app.get('/customers/:customerId/ai/insights', async (req, res) => {
  const { customerId } = req.params;
  const limit = Math.max(1, Math.min(8, Number((req.query.limit as string | undefined) ?? '3') || 3));
  const c = await collections();

  const customer = await c.customers.findOne(
    { id: customerId },
    { projection: { _id: 0, id: 1, name: 1, tariff: 1, price_eur_per_kwh: 1, fixed_daily_fee_eur: 1, contracted_power_kva: 1 } }
  );
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestTs = await getCustomerLatestTs(customerId);
  if (!latestTs) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const end = new Date(latestTs);

  // 1) Eficiência horária (já baseado em telemetria)
  const hourly = await getAvgByHourKwh(customerId, end, 7);
  const offPct = hourly.offpeakPct;

  // 2) Detetar base-load noturna
  const nightHours = new Set<number>([2, 3, 4, 5]);
  const nightAvgKwh = hourly.avgByHourKwhUtc.reduce((acc, v, h) => acc + (nightHours.has(h) ? v : 0), 0) / 4;
  const nightAvgWatts = (nightAvgKwh * 1000) / 1; // kWh por hora -> kW -> W

  // 3) Pequena análise contratual para dica
  const avgPrice = typeof (customer as any).price_eur_per_kwh === 'number' ? (customer as any).price_eur_per_kwh : RATE_EUR_PER_KWH;
  const currentTariff = String((customer as any).tariff ?? 'Simples');
  const shouldBi = offPct >= 0.42;

  const tips: Array<{ id: string; icon: string; text: string }>
    = [];

  const baseContext = await buildAssistantBaseContext(c, customer as any, {
    end,
    includeGrid: true,
    includeEnergyWindows: false,
    includeTopAppliances30d: false
  });

  // Contexto nacional (E-REDES) para tornar as dicas mais “factíveis”
  const gridCtx = (baseContext as any).grid;
  const renewPct = gridCtx?.injection?.renewablesSharePct;
  const gridTs = gridCtx?.injection?.ts;
  if (typeof renewPct === 'number' && Number.isFinite(renewPct)) {
    const pct = Math.round(renewPct);
    tips.push({
      id: 'grid-context',
      icon: '✦',
      text:
        pct >= 55
          ? `Contexto da rede (E-REDES): a injeção na distribuição está “mais verde” (~${pct}% renovável na última leitura). Boa altura para tarefas flexíveis.`
          : `Contexto da rede (E-REDES): a percentagem renovável na injeção está ~${pct}% na última leitura${gridTs ? ` (${new Date(gridTs).toLocaleString('pt-PT')})` : ''}. Se puder, evite concentrar consumos nos seus picos.`
    });
  }

  if (isBiTariff(currentTariff) || isTriTariff(currentTariff)) {
    const pct = Math.round(offPct * 100);
    tips.push({
      id: 'tariff-usage',
      icon: '✦',
      text: pct >= 50
        ? `Muito bom: ~${pct}% do seu consumo está em vazio. Continue a agendar tarefas flexíveis para a noite.`
        : `Tem bi-horário mas só ~${pct}% do consumo está em vazio. Se mover alguns consumos 18h–21h para depois das 22h, ganha mais.`
    });
  } else {
    if (shouldBi) {
      tips.push({
        id: 'tariff-switch',
        icon: '✦',
        text: `O seu consumo tem ~${Math.round(offPct * 100)}% em vazio. Um bi-horário pode fazer sentido para reduzir custo sem mexer muito nos hábitos.`
      });
    } else {
      tips.push({
        id: 'tariff-stable',
        icon: '✦',
        text: 'O seu consumo não está muito concentrado em vazio. Tarifa simples tende a ser mais previsível para si.'
      });
    }
  }

  if (nightAvgWatts >= 180) {
    tips.push({
      id: 'standby',
      icon: '✦',
      text: `Detetámos consumo noturno médio ~${Math.round(nightAvgWatts)}W (2h–5h). Verifique stand-by (TV/Box/PC) e carregadores sempre ligados.`
    });
  } else {
    tips.push({
      id: 'night-ok',
      icon: '✦',
      text: 'Boa notícia: o consumo noturno (2h–5h) está baixo — sinal de pouco stand-by.'
    });
  }

  const peakHour = hourly.avgByHourKwhUtc
    .map((v, h) => ({ h, v }))
    .sort((a, b) => b.v - a.v)[0]?.h;
  if (typeof peakHour === 'number') {
    tips.push({
      id: 'peak-hour',
      icon: '✦',
      text: `A sua hora mais intensa costuma ser às ${String(peakHour).padStart(2, '0')}h. Se conseguir espalhar alguns consumos por 1–2 horas, reduz picos e stress no contador.`
    });
  }

  // Mantém só as melhores (com “pé e cabeça” e sem redundância)
  const out = tips.slice(0, limit);

  const assistantText = await llmGenerateText({
    kind: 'ai_insights_summary',
    customer: baseContext.customer,
    context: buildAssistantEnvelope({
      base: baseContext,
      extra: {
        lastUpdated: end.toISOString(),
        hourly,
        nightAvgWatts: Math.round(nightAvgWatts),
        renewablesSharePct: typeof renewPct === 'number' ? Math.round(renewPct) : null,
        tips: out
      }
    }),
    prompt:
      'Cria um resumo curto (2–4 frases) com os 2–3 insights mais relevantes e uma próxima ação concreta. ' +
      'Sem listas com bullets; pode usar "1)" apenas se ajudar. Não inventes números.',
    maxTokens: 220
  });

  const assistantTextFallback = (() => {
    const pct = Math.round(offPct * 100);
    const pieces: string[] = [];

    const isBi = isBiTariff(currentTariff) || isTriTariff(currentTariff);
    if (isBi) {
      pieces.push(
        pct >= 50
          ? `Você já coloca bastante consumo em vazio (~${pct}%). Mantenha tarefas flexíveis nesse período.`
          : `Apesar de ter bi-horário, só ~${pct}% está em vazio. Se mover 1–2 hábitos do fim da tarde para depois das 22h, tende a ganhar mais.`
      );
    } else {
      pieces.push(
        shouldBi
          ? `O seu consumo tem ~${pct}% em vazio; um bi-horário pode fazer sentido sem mudar muito os seus hábitos.`
          : 'O seu consumo não está muito concentrado em vazio; tarifa simples tende a ser mais previsível no dia-a-dia.'
      );
    }

    const nw = Math.round(nightAvgWatts);
    pieces.push(
      nw >= 180
        ? `De noite (2h–5h) há uma base média ~${nw}W: vale a pena atacar stand-by (box/TV/PC) e carregadores sempre na ficha.`
        : 'O consumo noturno (2h–5h) está baixo — bom sinal de pouco stand-by.'
    );

    if (typeof peakHour === 'number') {
      pieces.push(
        `O seu pico típico é por volta das ${String(peakHour).padStart(2, '0')}h; espalhar alguns consumos por 1–2 horas ajuda a reduzir picos e stress no contador.`
      );
    }

    // garante 2–4 frases curtas
    const text = pieces.slice(0, 3).join(' ');
    return text.length <= 600 ? text : text.slice(0, 585).trimEnd() + '…';
  })();

  return res.json({
    customerId,
    lastUpdated: end.toISOString(),
    tips: out,
    assistantText: assistantText ?? assistantTextFallback
  });
});

app.get('/customers/:customerId/power/suggestion', async (req, res) => {
  const { customerId } = req.params;

  const c = await collections();

  const customer = (await c.customers.findOne(
    { id: customerId },
    {
      projection: {
        _id: 0,
        id: 1,
        segment: 1,
        contracted_power_kva: 1,
        home_area_m2: 1,
        household_size: 1,
        has_solar: 1,
        ev_count: 1,
        price_eur_per_kwh: 1,
        fixed_daily_fee_eur: 1,
        tariff: 1
      }
    }
  )) as
    | {
        id: string;
        segment: string;
        contracted_power_kva: number;
        home_area_m2: number;
        household_size: number;
        has_solar: number;
        ev_count: number;
        price_eur_per_kwh: number;
        fixed_daily_fee_eur: number;
        tariff: string;
      }
    | null;
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestTsRows = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  const latestDoc = latestTsRows[0];
  if (!latestDoc) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const latest = { ts: latestDoc.ts.toISOString() };
  const end = new Date(latest.ts);
  const endIso = end.toISOString();
  const since30d = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  const since365d = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);

  const stats30Agg = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: since30d, $lte: end } } },
      { $group: { _id: null, peakWatts: { $max: '$watts' }, avgWatts: { $avg: '$watts' } } }
    ])
    .toArray();
  const stats30 = {
    peakWatts: Number(stats30Agg[0]?.peakWatts ?? 0),
    avgWatts: Number(stats30Agg[0]?.avgWatts ?? 0)
  };

  const peak365Agg = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: since365d, $lte: end } } },
      { $group: { _id: null, peakWatts: { $max: '$watts' } } }
    ])
    .toArray();
  const peak365 = { peakWatts: Number(peak365Agg[0]?.peakWatts ?? 0) };

  const contractedKva = Number(customer.contracted_power_kva ?? 0);
  const yearlyPeakKva = round1((Number(peak365.peakWatts ?? 0) / 1000));
  const usagePctOfContracted = contractedKva > 0 ? Math.round((yearlyPeakKva / contractedKva) * 100) : 0;

  // Histórico: probabilidade de exceder um cap (com base em amostras 15m)
  const count30 = {
    n: await c.customerTelemetry15m.countDocuments({ customer_id: customerId, ts: { $gte: since30d, $lte: end } })
  };

  const powerModel = loadPowerModel();
  let suggestedKva = contractedKva;
  let modelUsed: 'ai' | 'heuristic' = 'heuristic';

  if (powerModel) {
    try {
      const feats = makePowerFeatures(customer, Number(stats30.peakWatts ?? 0), Number(stats30.avgWatts ?? 0));
      suggestedKva = clampSuggestedPowerKva(predictRidge(powerModel, feats));
      modelUsed = 'ai';
    } catch {
      // fallback heurístico
    }
  }

  if (modelUsed === 'heuristic') {
    // Regra de fallback (sem modelo): dimensionar pelo pico recente com margem.
    const peakKva = (Number(stats30.peakWatts ?? 0) / 1000) / 0.85;
    const avgKva = (Number(stats30.avgWatts ?? 0) / 1000) * 2.2;
    const segMargin = customer.segment === 'industrial' ? 0.15 : customer.segment === 'sme' ? 0.1 : 0.08;
    const base = Math.max(1, peakKva, avgKva) * (1 + segMargin);
    suggestedKva = clampSuggestedPowerKva(Math.ceil(base * 10) / 10);
  }

  // Otimização custo vs risco: escolhe a melhor potência num conjunto de opções típicas.
  // Usa previsão IA (ai_model.json) para estimar risco futuro; se não houver modelo, usa o histórico 30d.
  const standardKvaOptions = [
    1.15, 2.3, 3.45, 4.6, 5.75, 6.9, 10.35, 13.8, 17.25, 20.7, 27.6, 34.5, 41.4, 48.3, 55.2
  ].filter((v) => v >= 1 && v <= 60);

  const priceEurPerKwh = typeof customer.price_eur_per_kwh === 'number' ? customer.price_eur_per_kwh : RATE_EUR_PER_KWH;
  const dim = daysInUtcMonthFromIso(endIso);
  const since24h = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const sum24hAgg = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: since24h, $lte: end } } },
      { $group: { _id: null, sumWatts: { $sum: '$watts' } } }
    ])
    .toArray();
  const kwhLast24h = sumKwhFromSumWatts(Number(sum24hAgg[0]?.sumWatts ?? 0));
  const forecastMonthKwh = kwhLast24h * dim;

  const fixedDailyFee = typeof customer.fixed_daily_fee_eur === 'number' ? customer.fixed_daily_fee_eur : 0;
  const feePerKvaPerDay = contractedKva > 0 ? fixedDailyFee / contractedKva : 0;

  const aiModel = loadAiModel();
  const latestRowDoc = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1, watts: 1, temp_c: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  const latestSample = {
    ts: (latestRowDoc[0]?.ts ?? end).toISOString(),
    watts: Number(latestRowDoc[0]?.watts ?? stats30.peakWatts ?? 0),
    temp_c: (latestRowDoc[0]?.temp_c ?? null) as number | null
  };

  const asCustomerProfile: CustomerProfile = {
    id: customer.id,
    segment: customer.segment,
    city: 'N/A',
    contracted_power_kva: customer.contracted_power_kva,
    tariff: customer.tariff,
    home_area_m2: customer.home_area_m2,
    household_size: customer.household_size,
    has_solar: customer.has_solar,
    ev_count: customer.ev_count,
    price_eur_per_kwh: priceEurPerKwh
  };

  const estimateFutureExceedProb = async (candidateKva: number) => {
    const capWatts = candidateKva * 1000 * 0.92;

    // Se tivermos modelo de consumo, simulamos até ao fim do mês para estimar risco futuro.
    if (aiModel) {
      try {
        const featCount = makeFeatures(
          new Date(latestSample.ts),
          asCustomerProfile,
          latestSample.watts,
          latestSample.temp_c ?? undefined
        ).length;
        if ('feature_names' in aiModel && aiModel.feature_names.length !== featCount) throw new Error('feature mismatch');

        const monthEnd = startOfNextUtcMonth(new Date(latestSample.ts));
        const intervalMinutes = aiModel.interval_minutes ?? 15;
        let ts = new Date(latestSample.ts);
        let lastWatts = latestSample.watts;

        let exceed = 0;
        let total = 0;
        const maxSteps = 31 * 96;
        let steps = 0;

        while (ts.getTime() < monthEnd.getTime() && steps < maxSteps) {
          ts = new Date(ts.getTime() + intervalMinutes * 60 * 1000);
          if (ts.getTime() >= monthEnd.getTime()) break;
          const feats = makeFeatures(ts, asCustomerProfile, lastWatts, latestSample.temp_c ?? undefined);
          const predictedRaw = predictNextWatts(aiModel, feats);
          const predictedWatts = clampPredictionForCustomer(predictedRaw, { ...asCustomerProfile, contracted_power_kva: candidateKva });
          if (predictedWatts > capWatts) exceed += 1;
          total += 1;
          lastWatts = predictedWatts;
          steps += 1;
        }

        return total ? exceed / total : 0;
      } catch {
        // cai para histórico
      }
    }

    // Fallback histórico 30d
    const total = Number(count30.n ?? 0);
    if (!total) return 0;
    const exceedCount = await c.customerTelemetry15m.countDocuments({
      customer_id: customerId,
      ts: { $gte: since30d, $lte: end },
      watts: { $gt: capWatts }
    });
    return exceedCount / total;
  };

  const riskWeight = customer.segment === 'industrial' ? 120 : customer.segment === 'sme' ? 85 : 55;

  const candidates = Array.from(
    new Set([
      ...standardKvaOptions,
      contractedKva,
      clampSuggestedPowerKva(suggestedKva)
    ].map((v) => round1(v)))
  ).sort((a, b) => a - b);

  const scoreCandidate = async (candidateKva: number) => {
    const exceedProb = clamp01(await estimateFutureExceedProb(candidateKva));
    const powerFeeMonth = feePerKvaPerDay > 0 ? feePerKvaPerDay * candidateKva * dim : 0;
    const energyFeeMonth = forecastMonthKwh * priceEurPerKwh;

    // Penaliza fortemente riscos acima de 2%.
    const riskPenalty = riskWeight * Math.pow(exceedProb, 1.7) * (dim * 10);
    const score = powerFeeMonth + energyFeeMonth + riskPenalty;

    return { candidateKva, exceedProb, powerFeeMonth, energyFeeMonth, score };
  };

  const scored = await Promise.all(candidates.map(scoreCandidate));
  scored.sort((a, b) => a.score - b.score);
  const best = scored[0];

  suggestedKva = round1(best?.candidateKva ?? suggestedKva);

  const ratio = contractedKva > 0 ? suggestedKva / contractedKva : 1;
  const status = ratio <= 0.85 ? 'sobredimensionado' : ratio >= 1.1 ? 'subdimensionado' : 'ok';

  const current = await scoreCandidate(contractedKva || suggestedKva);
  const savingsMonth = Number(((current.powerFeeMonth ?? 0) - (best.powerFeeMonth ?? 0)).toFixed(2));
  const riskExceedPct = Number(((best.exceedProb ?? 0) * 100).toFixed(1));

  let title = 'Equilibrado.';
  let message = 'A sua potência contratada parece adequada para o seu padrão de consumo.';

  if (status === 'sobredimensionado') {
    title = 'Sobredimensionado.';
    message = `Potência sugerida ${suggestedKva.toFixed(1)}kVA (risco ~${riskExceedPct}%).`;
  }
  if (status === 'subdimensionado') {
    title = 'Subdimensionado.';
    message = `Potência sugerida ${suggestedKva.toFixed(1)}kVA para reduzir risco de exceder (risco ~${riskExceedPct}%).`;
  }
  if (status === 'ok') {
    message = `Potência sugerida ${suggestedKva.toFixed(1)}kVA (risco ~${riskExceedPct}%). Mantém bom equilíbrio entre custo e segurança.`;
  }

  const baseContext = await buildAssistantBaseContext(c, customer as any, {
    end,
    includeGrid: true,
    includeEnergyWindows: false,
    includeTopAppliances30d: false
  });

  const improvedPowerMessage = await llmImproveText({
    kind: 'power_suggestion_message',
    customer: baseContext.customer,
    context: buildAssistantEnvelope({
      base: baseContext,
      extra: {
        status,
        contractedKva: round1(contractedKva),
        suggestedIdealKva: suggestedKva,
        yearlyPeakKva,
        usagePctOfContracted,
        riskExceedPct,
        savingsMonth
      }
    }),
    draft: message,
    maxTokens: 160
  });
  if (improvedPowerMessage) message = improvedPowerMessage;

  return res.json({
    customerId,
    lastUpdated: latest.ts,
    contractedKva: round1(contractedKva),
    yearlyPeakKva,
    suggestedIdealKva: suggestedKva,
    usagePctOfContracted,
    status,
    title,
    message,
    modelUsed,
    modelMetrics: powerModel?.metrics ?? null,
    riskExceedPct,
    savingsMonth,
    alternatives: scored.map((s) => ({
      kva: round1(s.candidateKva),
      riskExceedPct: Number((s.exceedProb * 100).toFixed(1)),
      powerFeeMonth: Number(s.powerFeeMonth.toFixed(2)),
      score: Number(s.score.toFixed(2))
    }))
  });
});

app.get('/ai/model', (_req, res) => {
  const model = loadAiModel();
  if (!model) return res.status(404).json({ message: 'Modelo não encontrado. Execute: py -3 apps/backend/ai_train.py' });
  return res.json({
    version: model.version,
    trained_at: model.trained_at,
    interval_minutes: model.interval_minutes,
    metrics: model.metrics ?? null
  });
});

app.get('/ai/retrain/status', (_req, res) => {
  return res.json({ status: getAiRetrainStatus() });
});

app.post('/ai/retrain', async (req, res) => {
  const required = process.env.KYNEX_ADMIN_TOKEN;
  if (required && req.header('x-admin-token') !== required) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  const out = await runAiRetrainOnce();
  return res.json(out);
});

app.get('/ai/customers', async (_req, res) => {
  const c = await collections();
  const customers = await c.customers
    .find(
      {},
      {
        projection: {
          _id: 0,
          id: 1,
          name: 1,
          segment: 1,
          city: 1,
          contracted_power_kva: 1,
          tariff: 1,
          utility: 1,
          price_eur_per_kwh: 1,
          fixed_daily_fee_eur: 1,
          has_smart_meter: 1,
          home_area_m2: 1,
          household_size: 1,
          locality_type: 1,
          dwelling_type: 1,
          build_year_band: 1,
          heating_sources: 1,
          has_solar: 1,
          ev_count: 1,
          alert_sensitivity: 1,
          main_appliances: 1,
          created_at: 1
        }
      }
    )
    .sort({ created_at: -1 })
    .toArray();

  res.json(customers.map((cust) => ({ ...cust, created_at: cust.created_at.toISOString() })));
});

const createCustomerSchema = z.object({
  name: z.string().min(1).max(120),
  segment: z.string().min(1).max(40).default('residential'),
  city: z.string().min(1).max(80),
  contracted_power_kva: z.number().min(1).max(60),
  tariff: z.string().min(1).max(60),
  utility: z.string().min(1).max(80),

  price_eur_per_kwh: z.number().min(0.05).max(1.2).optional(),
  fixed_daily_fee_eur: z.number().min(0).max(5).optional(),
  has_smart_meter: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),

  home_area_m2: z.number().min(20).max(10000).optional(),
  household_size: z.number().int().min(1).max(50).optional(),
  locality_type: z.string().min(1).max(30).optional(),
  dwelling_type: z.string().min(1).max(40).optional(),
  build_year_band: z.string().min(1).max(40).optional(),

  heating_sources: z.union([z.array(z.string().min(1).max(80)), z.string().max(500)]).optional(),
  has_solar: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  ev_count: z.number().int().min(0).max(20).optional(),

  alert_sensitivity: z.string().min(1).max(20).optional(),
  main_appliances: z.union([z.array(z.string().min(1).max(80)), z.string().max(800)]).optional()
});

type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

const toInt01 = (v: unknown, fallback: number) => {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v ? 1 : 0;
  return fallback;
};

const toCsv = (v: unknown) => {
  if (Array.isArray(v)) return v.join(',');
  if (typeof v === 'string') return v;
  return '';
};

async function createCustomer(cols: Collections, input: CreateCustomerInput): Promise<string> {
  const id = `U_${crypto.randomUUID()}`;
  const createdAt = new Date();
  await cols.customers.insertOne({
    id,
    name: input.name,
    segment: input.segment,
    city: input.city,
    contracted_power_kva: input.contracted_power_kva,
    tariff: input.tariff,
    utility: input.utility,

    home_area_m2: input.home_area_m2 ?? 80,
    household_size: input.household_size ?? 2,
    locality_type: input.locality_type ?? 'Urbana',
    dwelling_type: input.dwelling_type ?? 'Apartamento',
    build_year_band: input.build_year_band ?? '2000-2014',
    heating_sources: toCsv(input.heating_sources),

    has_solar: toInt01(input.has_solar, 0),
    ev_count: input.ev_count ?? 0,
    has_smart_meter: toInt01(input.has_smart_meter, 1),
    price_eur_per_kwh: input.price_eur_per_kwh ?? RATE_EUR_PER_KWH,
    fixed_daily_fee_eur: input.fixed_daily_fee_eur ?? 0,

    alert_sensitivity: input.alert_sensitivity ?? 'Média',
    main_appliances: toCsv(input.main_appliances),

    created_at: createdAt
  });
  return id;
}

app.post('/auth/register', async (req, res) => {
  const schema = createCustomerSchema.extend({
    email: z.string().email().max(180),
    password: z.string().min(1).max(72)
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });

  const email = normalizeEmail(parsed.data.email);
  const policy = validatePassword(parsed.data.password);
  if (!policy.ok) return res.status(400).json({ message: 'Password inválida', errors: policy.errors });

  const cols = await collections();
  const exists = await cols.users.findOne({ email }, { projection: { _id: 0, id: 1 } });
  if (exists) return res.status(409).json({ message: 'Email já registado' });

  let customerId: string | null = null;
  try {
    customerId = await createCustomer(cols, parsed.data);
    const userId = `USR_${crypto.randomUUID()}`;
    const { saltB64, hashB64 } = await hashPassword(parsed.data.password);

    await cols.users.insertOne({
      id: userId,
      customer_id: customerId,
      email,
      password_salt_b64: saltB64,
      password_hash_b64: hashB64,
      created_at: new Date()
    });

    return res.status(201).json({ ok: true });
  } catch (err) {
    if (customerId) {
      cols.customers.deleteOne({ id: customerId }).catch(() => null);
    }
    return res.status(500).json({ message: 'Erro ao registar utilizador' });
  }
});

app.post('/auth/login', async (req, res) => {
  const schema = z.object({
    email: z.string().email().max(180),
    password: z.string().min(1).max(72)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });

  const cols = await collections();
  const email = normalizeEmail(parsed.data.email);
  const user = await cols.users.findOne(
    { email },
    { projection: { _id: 0, id: 1, email: 1, customer_id: 1, password_salt_b64: 1, password_hash_b64: 1 } }
  );
  if (!user) return res.status(401).json({ message: 'Credenciais inválidas' });

  const ok = await verifyPassword(parsed.data.password, user.password_salt_b64, user.password_hash_b64);
  if (!ok) return res.status(401).json({ message: 'Credenciais inválidas' });

  const token = newToken();
  const tokenHash = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const sessionId = `SES_${crypto.randomUUID()}`;
  await cols.authSessions.insertOne({
    id: sessionId,
    user_id: user.id,
    customer_id: user.customer_id,
    token_hash: tokenHash,
    created_at: now,
    expires_at: expiresAt,
    last_seen_at: now
  });

  return res.json({
    token,
    customerId: user.customer_id,
    userId: user.id,
    expiresAt: expiresAt.toISOString()
  });
});

app.post('/ai/customers', async (req, res) => {
  console.log('POST /ai/customers payload:', JSON.stringify(req.body));
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error('POST /ai/customers schema error:', JSON.stringify(parsed.error.flatten().fieldErrors));
    return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
  }

  try {
    const cols = await collections();
    const id = await createCustomer(cols, parsed.data);
    console.log('POST /ai/customers created id:', id);
    return res.status(201).json({ id });
  } catch (err) {
    console.error('POST /ai/customers insert error:', err);
    return res.status(500).json({ message: 'Erro ao criar cliente' });
  }
});

app.get('/ai/forecast/:customerId', async (req, res) => {
  const { customerId } = req.params;
  const horizonRaw = (req.query.horizon as string | undefined) ?? '1';
  const horizon = Math.max(1, Math.min(96, Number.parseInt(horizonRaw, 10) || 1));

  const model = loadAiModel();
  if (!model) return res.status(503).json({ message: 'Modelo não encontrado. Execute: py -3 apps/backend/ai_train.py' });

  const c = await collections();

  const customer = (await c.customers.findOne(
    { id: customerId },
    {
      projection: {
        _id: 0,
        id: 1,
        segment: 1,
        city: 1,
        ipma_global_id_local: 1,
        contracted_power_kva: 1,
        tariff: 1,
        home_area_m2: 1,
        household_size: 1,
        has_solar: 1,
        ev_count: 1,
        price_eur_per_kwh: 1
      }
    }
  )) as CustomerProfile | null;
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latestRow = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1, watts: 1, temp_c: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  const latestDoc = latestRow[0];
  if (!latestDoc) {
    return res.status(404).json({ message: 'Sem telemetria para este cliente (ainda). Aguarde o simulador gerar dados.' });
  }

  const latest = { ts: latestDoc.ts.toISOString(), watts: latestDoc.watts, temp_c: latestDoc.temp_c ?? null };

  // Meteorologia IPMA (opcional): usa temperatura prevista para melhorar as previsões.
  // Mantém fallback para o comportamento atual se IPMA estiver indisponível.
  let ipma: { globalIdLocal: number; dataUpdate?: string } | null = null;
  let ipmaForecast: Awaited<ReturnType<typeof getIpmaDailyForecast>> = null;
  try {
    const override = (customer as any)?.ipma_global_id_local;
    const gid = Number.isFinite(override) && Number(override) > 0 ? Number(override) : await resolveIpmaGlobalIdLocal(customer.city);
    ipmaForecast = await getIpmaDailyForecast(gid);
    if (ipmaForecast) ipma = { globalIdLocal: gid, dataUpdate: ipmaForecast.dataUpdate };
  } catch {
    // ignora e mantém fallback
  }

  try {
    const featureCount = makeFeatures(new Date(latest.ts), customer, latest.watts, latest.temp_c ?? undefined).length;
    if ('feature_names' in model && model.feature_names.length !== featureCount) {
      return res.status(409).json({
        message: 'Modelo incompatível com as features atuais. Re-treine o modelo.',
        expectedFeatures: featureCount,
        modelFeatures: 'feature_names' in model ? model.feature_names.length : null,
        hint: 'Execute: py -3 apps/backend/ai_train.py'
      });
    }
  } catch {
    return res.status(409).json({ message: 'Falha ao preparar features. Re-treine o modelo.' });
  }

  const intervalMinutes = model.interval_minutes ?? 15;
  const intervalHours = intervalMinutes / 60;
  const rateEurPerKwh = typeof customer.price_eur_per_kwh === 'number' ? customer.price_eur_per_kwh : RATE_EUR_PER_KWH;

  let ts = new Date(latest.ts);
  let lastWatts = latest.watts;
  const points = [] as Array<{ ts: string; predictedWatts: number; predictedKwh: number; predictedEuros: number; temp_c?: number | null }>;

  const lisbonDateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const lisbonTimeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const getLisbonLocal = (d: Date): { ymd: string; minutesOfDay: number } | null => {
    try {
      const ymd = lisbonDateFmt.format(d); // en-CA => YYYY-MM-DD
      const parts = lisbonTimeFmt.formatToParts(d);
      const hh = Number(parts.find((p) => p.type === 'hour')?.value);
      const mm = Number(parts.find((p) => p.type === 'minute')?.value);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
      return { ymd, minutesOfDay: hh * 60 + mm };
    } catch {
      return null;
    }
  };

  for (let i = 0; i < horizon; i += 1) {
    ts = new Date(ts.getTime() + intervalMinutes * 60 * 1000);
    const local = getLisbonLocal(ts);
    const ymdLocal = local?.ymd ?? ts.toISOString().slice(0, 10);
    const minutesLocal = local?.minutesOfDay ?? (ts.getUTCHours() * 60 + ts.getUTCMinutes());

    const ipmaTemp = ipmaForecast ? getIpmaTempForLocalDateTime(ipmaForecast, ymdLocal, minutesLocal) : null;
    const tempC = ipmaTemp != null ? ipmaTemp : (latest.temp_c ?? undefined);

    const feats = makeFeatures(ts, customer, lastWatts, typeof tempC === 'number' ? tempC : undefined);
    const predictedRaw = predictNextWatts(model, feats);
    const predictedWatts = clampPredictionForCustomer(predictedRaw, customer);
    const predictedKwh = (predictedWatts / 1000) * intervalHours;
    const predictedEuros = predictedKwh * rateEurPerKwh;
    points.push({
      ts: ts.toISOString(),
      predictedWatts: Math.round(predictedWatts),
      predictedKwh: Number(predictedKwh.toFixed(4)),
      predictedEuros: Number(predictedEuros.toFixed(4)),
      temp_c: typeof tempC === 'number' ? Number(tempC.toFixed(1)) : latest.temp_c
    });
    lastWatts = predictedWatts;
  }

  return res.json({
    customerId,
    horizon,
    intervalMinutes,
    lastObserved: { ts: latest.ts, watts: latest.watts },
    weather: ipma ? { source: 'IPMA', globalIdLocal: ipma.globalIdLocal, dataUpdate: ipma.dataUpdate } : null,
    points
  });
});

export default app;
