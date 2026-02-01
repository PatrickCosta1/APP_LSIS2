import { getIpmaDailyForecast, getIpmaTempForLocalDateTime, getIpmaWeatherTypeDescPt, resolveIpmaGlobalIdLocal } from './ipma';
import cors from 'cors';
import express from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { getCollections, initDb, type Collections } from './db';
import { clampPredictionForCustomer, loadAiModel, makeFeatures, predictNextWatts, type CustomerProfile } from './ai';
import { clampSuggestedPowerKva, loadPowerModel, makePowerFeatures, predictRidge } from './powerAi';
import { getAiRetrainStatus, runAiRetrainOnce } from './aiTrainer';
import { getCustomerChatHistory, handleCustomerChat } from './chat';
import { hashPassword, hashToken, normalizeEmail, newToken, validatePassword, verifyPassword } from './auth';
import { getEredesNationalContext } from './openDataContext';
import { llmImproveText } from './llm/assistantText';
import { buildAssistantBaseContext, buildAssistantEnvelope } from './assistantContext';
import { inferAppliancesFromAggregate } from './nilmInfer';
import { extractNilmSessions15m, inferFromFingerprints, type CustomerNilmFingerprintDoc } from './nilmService';
import { extractInvoiceFromFile, extractInvoiceFromFiles, newInvoiceId } from './invoiceEngine';
import { compareWithPublicTariffs } from './tariffComparison';
import { isShellyMqttConfigured, shellySwitchGetStatus, shellySwitchSet } from './shellyMqtt';
import { forecastMonth } from './forecastService';

const app = express();

app.use(cors());
app.use(express.json());

const invoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.max(1_000_000, Math.min(25_000_000, Number(process.env.KYNEX_MAX_INVOICE_BYTES ?? 12_000_000)))
  }
});

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

async function readDailyKwhFromTelemetry(customerId: string, start: Date, endExclusive: Date) {
  const c = await collections();
  const rows = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: start, $lt: endExclusive } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$ts', timezone: 'UTC' } },
          sumWatts: { $sum: '$watts' }
        }
      },
      { $sort: { _id: 1 } }
    ])
    .toArray();
  return rows.map((r: any) => ({ day: String(r._id), kwh: sumKwhFromSumWatts(Number(r?.sumWatts ?? 0)) }));
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

function getShellyBaseUrl() {
  const raw = String(process.env.SHELLY_BASE_URL ?? 'http://192.168.1.185').trim();
  return raw.replace(/\/+$/, '');
}

async function shellyRequest(path: string, opts?: { timeoutMs?: number }) {
  const base = getShellyBaseUrl();
  const url = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const controller = new AbortController();
  const timeoutMs = Math.max(200, Math.min(8000, opts?.timeoutMs ?? 5000)); // Aumentar timeout padrão para 5s
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // eslint-disable-next-line no-console
    console.log(`[SHELLY] Fetching: ${url} (timeout: ${timeoutMs}ms)`);
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-console
    console.log(`[SHELLY] Response: ${res.ok ? 'OK' : 'ERROR'} (${res.status})`);
    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[SHELLY] Request failed:`, err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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

  const { from, to, bucket = '15m', customerId } = req.query as { from?: string; to?: string; bucket?: string; customerId?: string };
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return res.status(400).json({ message: 'from/to inválidos' });
  }

  if (bucket === '15m') {
    const resolvedCustomerId = String(customerId ?? process.env.KYNEX_TELEMETRY_CSV_CUSTOMER_ID ?? '').trim();

    // Compatibilidade: quando não há customerId (ex.: testes/seed), usa o dataset legacy.
    if (!resolvedCustomerId) {
      const rows = await c.samples
        .find({ ts: { $gte: start, $lte: end } }, { projection: { ts: 1, watts: 1, euros: 1 } })
        .sort({ ts: 1 })
        .toArray();
      return res.json(rows.map((r) => ({ ts: r.ts.toISOString(), watts: r.watts, euros: r.euros })));
    }

    const rows = await c.customerTelemetry15m
      .find({ customer_id: resolvedCustomerId, ts: { $gte: start, $lte: end } }, { projection: { ts: 1, watts: 1, euros: 1 } })
      .sort({ ts: 1 })
      .toArray();

    return res.json(rows.map((r) => ({ ts: r.ts.toISOString(), watts: r.watts, euros: r.euros })));
  }

  const rows = await c.samples
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
    { projection: { _id: 0, id: 1, name: 1, segment: 1, city: 1, home_area_m2: 1, price_eur_per_kwh: 1, fixed_daily_fee_eur: 1, contracted_power_kva: 1 } }
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

  // Previsão mensal (refinada): consumo já realizado + projeção para dias restantes.
  // Base: média diária recente (últimos N dias completos), com robustez (trim) e faixa (P10/P90).
  const dim = daysInUtcMonthFromIso(endIso);
  const monthStartDay = startOfUtcMonthFromIso(endIso);
  const nextMonthStart = startOfNextUtcMonth(end);
  const endDay = startOfUtcDay(end);

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const remainingDays = Math.max(0, (nextMonthStart.getTime() - end.getTime()) / MS_PER_DAY);

  const lookbackDays = 7;
  const historyStartRaw = addUtcDays(endDay, -lookbackDays);
  const historyStart = historyStartRaw < monthStartDay ? monthStartDay : historyStartRaw;

  const dailyAgg = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: historyStart, $lt: endDay } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$ts', timezone: 'UTC' } },
          sumWatts: { $sum: '$watts' }
        }
      },
      { $sort: { _id: 1 } }
    ])
    .toArray();

  const dailyKwhs = dailyAgg
    .map((r: any) => sumKwhFromSumWatts(Number(r?.sumWatts ?? 0)))
    .filter((x: number) => Number.isFinite(x) && x >= 0);

  const forecastBasisDays = dailyKwhs.length;
  let avgDailyKwh = forecastBasisDays ? dailyKwhs.reduce((a, b) => a + b, 0) / forecastBasisDays : kwhLast24h;

  // Trim simples para reduzir impacto de outliers (picos/quebras ocasionais)
  if (forecastBasisDays >= 5) {
    const s = dailyKwhs.slice().sort((a, b) => a - b);
    const trimmed = s.slice(1, -1);
    avgDailyKwh = trimmed.reduce((a, b) => a + b, 0) / Math.max(1, trimmed.length);
  }

  const sortedKwh = dailyKwhs.slice().sort((a, b) => a - b);
  const pickQ = (p: number) => {
    if (!sortedKwh.length) return avgDailyKwh;
    const idx = Math.floor((sortedKwh.length - 1) * p);
    return sortedKwh[Math.max(0, Math.min(sortedKwh.length - 1, idx))];
  };
  const q10 = pickQ(0.1);
  const q90 = pickQ(0.9);

  let forecastMonthKwh = monthToDateKwh + avgDailyKwh * remainingDays;
  forecastMonthKwh = Math.max(monthToDateKwh, forecastMonthKwh);

  const forecastMonthKwhLow = Math.max(monthToDateKwh, monthToDateKwh + q10 * remainingDays);
  const forecastMonthKwhHigh = Math.max(forecastMonthKwhLow, monthToDateKwh + q90 * remainingDays);

  const forecastMonthEuros = forecastMonthKwh * price;
  const forecastMonthEurosLow = forecastMonthKwhLow * price;
  const forecastMonthEurosHigh = forecastMonthKwhHigh * price;

  // Previsão mensal (Service Layer): usa histórico, sazonalidade e IPMA (quando disponível).
  // Mantém compatibilidade: os campos *Euros continuam a ser energia * preço (sem termo fixo),
  // e adicionamos *BillEuros incluindo termo fixo diário.
  let improved: Awaited<ReturnType<typeof forecastMonth>> | null = null;
  try {
    improved = await forecastMonth({
      customerId,
      end,
      city: typeof (customer as any).city === 'string' ? String((customer as any).city) : null,
      monthToDateKwh,
      priceEurPerKwh: price,
      fixedDailyFeeEur:
        typeof (customer as any).fixed_daily_fee_eur === 'number' && Number.isFinite((customer as any).fixed_daily_fee_eur)
          ? Number((customer as any).fixed_daily_fee_eur)
          : 0,
      readDailyKwh: readDailyKwhFromTelemetry
    });
  } catch {
    improved = null;
  }

  const outForecastMonthKwh = improved?.forecastMonthKwh ?? Number(forecastMonthKwh.toFixed(2));
  const outForecastMonthKwhLow = improved?.lowKwh ?? Number(forecastMonthKwhLow.toFixed(2));
  const outForecastMonthKwhHigh = improved?.highKwh ?? Number(forecastMonthKwhHigh.toFixed(2));
  const outForecastMonthEuros = Number((outForecastMonthKwh * price).toFixed(2));
  const outForecastMonthEurosLow = Number((outForecastMonthKwhLow * price).toFixed(2));
  const outForecastMonthEurosHigh = Number((outForecastMonthKwhHigh * price).toFixed(2));
  const outForecastMethod = improved?.method ?? 'recent_daily_avg_trim_p10_p90';
  const outForecastWeatherOk = improved ? Boolean(improved.ipmaOk) : false;
  const fixedDailyFee =
    typeof (customer as any).fixed_daily_fee_eur === 'number' && Number.isFinite((customer as any).fixed_daily_fee_eur)
      ? Number((customer as any).fixed_daily_fee_eur)
      : 0;
  const billFixedEur = fixedDailyFee * dim;
  const outForecastMonthBillEuros = Number((outForecastMonthKwh * price + billFixedEur).toFixed(2));
  const outForecastMonthBillEurosLow = Number((outForecastMonthKwhLow * price + billFixedEur).toFixed(2));
  const outForecastMonthBillEurosHigh = Number((outForecastMonthKwhHigh * price + billFixedEur).toFixed(2));

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

  // Delta vs mês anterior: consumo até hoje vs mesmo período no mês anterior
  const lastMonthStart = addUtcDays(monthStart, -dim);
  const lastMonthEnd = monthStart;
  const lastMonthSameDayEnd = new Date(lastMonthEnd.getTime() + (end.getTime() - monthStart.getTime()));

  const lastMonthPeriodAgg = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: lastMonthStart, $lt: lastMonthSameDayEnd } } },
      { $group: { _id: null, sumWatts: { $sum: '$watts' } } }
    ])
    .toArray();
  const lastMonthKwh = sumKwhFromSumWatts(Number(lastMonthPeriodAgg[0]?.sumWatts ?? 0));
  const lastMonthEuros = lastMonthKwh * price;
  const deltaPctVsLastMonth = lastMonthEuros > 0 ? ((monthToDateEuros / lastMonthEuros) - 1) * 100 : 0;

  // Delta vs pago no mês anterior: usado mês anterior vs previsto este mês
  const deltaPctVsForecast = forecastMonthEuros > 0 ? ((lastMonthEuros / forecastMonthEuros) - 1) * 100 : 0;

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
    forecastMonthKwh: outForecastMonthKwh,
    forecastMonthEuros: outForecastMonthEuros,
    forecastMonthKwhLow: outForecastMonthKwhLow,
    forecastMonthKwhHigh: outForecastMonthKwhHigh,
    forecastMonthEurosLow: outForecastMonthEurosLow,
    forecastMonthEurosHigh: outForecastMonthEurosHigh,
    forecastMethod: outForecastMethod,
    forecastWeatherOk: outForecastWeatherOk,
    forecastMonthBillEuros: outForecastMonthBillEuros,
    forecastMonthBillEurosLow: outForecastMonthBillEurosLow,
    forecastMonthBillEurosHigh: outForecastMonthBillEurosHigh,
    forecastAvgDailyKwh: Number(avgDailyKwh.toFixed(2)),
    forecastBasisDays,
    forecastRemainingDays: Number(remainingDays.toFixed(2)),
    similarKwhLast24h: Number(similarKwhLast24h.toFixed(2)),
    similarDeltaPct: Number(similarDeltaPct.toFixed(1)),
    priceEurPerKwh: Number(price.toFixed(4)),
    deltaPctVsLastMonth: Number(deltaPctVsLastMonth.toFixed(0)),
    deltaPctVsForecast: Number(deltaPctVsForecast.toFixed(0))
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
  if (!['dia', 'semana', 'mes'].includes(range)) {
    return res.status(400).json({ message: 'range inválido (dia|semana|mes)' });
  }

  const dateRaw = typeof req.query.date === 'string' ? req.query.date : undefined;
  const daysRaw = typeof req.query.days === 'string' ? req.query.days : undefined;
  const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
  const toRaw = typeof req.query.to === 'string' ? req.query.to : undefined;
  const granRaw = typeof req.query.granularity === 'string' ? req.query.granularity : undefined;

  const granularity = (() => {
    const g = String(granRaw ?? '').trim().toLowerCase();
    if (!g) return null;
    if (g === '15m' || g === '1h' || g === '1d') return g as '15m' | '1h' | '1d';
    return 'invalid' as const;
  })();

  if (granularity === 'invalid') {
    return res.status(400).json({ message: 'granularity inválida (15m|1h|1d)' });
  }

  const days = (() => {
    const n = Number(daysRaw);
    if (!Number.isFinite(n)) return null;
    const v = Math.floor(n);
    if (v < 1 || v > 60) return null;
    return v;
  })();

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

  const parseIsoDate = (raw: string) => {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  };

  const floorTo15mUtc = (d: Date) => {
    const ms = d.getTime();
    const step = 15 * 60 * 1000;
    return new Date(Math.floor(ms / step) * step);
  };

  const floorToHourUtc = (d: Date) => {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0));
  };

  const floorToDayUtc = (d: Date) => {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  };

  const parseDayKey = (raw: string) => {
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
    if (mo < 1 || mo > 12) return null;
    if (d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    // valida que bate no mesmo dia (evita 2026-02-31 virar março)
    const key = toDayKeyUtc(dt);
    if (key !== raw) return null;
    return { dayKey: key, dayStart: dt, dayEnd: new Date(dt.getTime() + 24 * 60 * 60 * 1000) };
  };

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

  const sumByBucket = async (from: Date, to: Date, format: string) => {
    const rows = await c.customerTelemetry15m
      .aggregate([
        { $match: { customer_id: customerId, ts: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: { $dateToString: { format, date: '$ts' } },
            sumWatts: { $sum: '$watts' }
          }
        }
      ])
      .toArray();
    const map = new Map<string, number>();
    for (const r of rows) map.set(String(r._id), sumKwhFromSumWatts(Number(r.sumWatts ?? 0)));
    return map;
  };

  const sumByHour = async (from: Date, to: Date) => {
    const rows = await c.customerTelemetry15m
      .aggregate([
        { $match: { customer_id: customerId, ts: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d %H:00', date: '$ts' } },
            sumWatts: { $sum: '$watts' }
          }
        }
      ])
      .toArray();
    const map = new Map<string, number>();
    for (const r of rows) map.set(String(r._id), sumKwhFromSumWatts(Number(r.sumWatts ?? 0)));
    return map;
  };

  const sumBy15m = async (from: Date, to: Date) => {
    return sumByBucket(from, to, '%Y-%m-%d %H:%M');
  };

  const buildSeriesByWindow = async (opts: {
    from: Date;
    to: Date;
    granularity: '15m' | '1h' | '1d';
  }) => {
    const { from, to } = opts;
    const g = opts.granularity;
    if (!(from instanceof Date) || !(to instanceof Date)) throw new Error('invalid_dates');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('invalid_dates');
    if (from.getTime() >= to.getTime()) throw new Error('invalid_range');

    const bucketMs = g === '15m' ? 15 * 60 * 1000 : g === '1h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const maxPoints = 2500;
    const approx = Math.ceil((to.getTime() - from.getTime()) / bucketMs);
    if (approx > maxPoints) throw new Error('too_large');

    const fromAligned = g === '15m' ? floorTo15mUtc(from) : g === '1h' ? floorToHourUtc(from) : floorToDayUtc(from);
    const toAligned = to;

    const actual =
      g === '15m' ? await sumBy15m(fromAligned, toAligned)
      : g === '1h' ? await sumByHour(fromAligned, toAligned)
      : await sumByDay(fromAligned, toAligned);

    const labels: string[] = [];
    const values: number[] = [];

    for (let t = fromAligned.getTime(); t < toAligned.getTime(); t += bucketMs) {
      const dt = new Date(t);
      const dayKey = toDayKeyUtc(dt);
      const hh = String(dt.getUTCHours()).padStart(2, '0');
      const mm = String(dt.getUTCMinutes()).padStart(2, '0');

      const key =
        g === '1d' ? dayKey
        : g === '1h' ? `${dayKey} ${hh}:00`
        : `${dayKey} ${hh}:${mm}`;

      // labels para UI: se for apenas 1 dia, mostra só hora; se atravessar dias, inclui dia
      const label = (() => {
        if (g === '1d') return dayKey;
        const spansDays = toDayKeyUtc(fromAligned) !== toDayKeyUtc(new Date(toAligned.getTime() - 1));
        return spansDays ? key : `${hh}:${mm}`;
      })();

      labels.push(label);
      values.push(Number(((actual.get(key) ?? 0)).toFixed(2)));
    }

    return { labels, values };
  };

  const customWindow = (() => {
    if (!fromRaw && !toRaw) return null;
    if (!fromRaw || !toRaw) return 'invalid' as const;
    const from = parseIsoDate(fromRaw);
    const to = parseIsoDate(toRaw);
    if (!from || !to) return 'invalid' as const;
    return { from, to };
  })();

  if (customWindow === 'invalid') {
    return res.status(400).json({ message: 'from/to inválidos (ISO datetime)'});
  }

  if (customWindow) {
    const g = granularity ?? '15m';
    try {
      const { labels, values } = await buildSeriesByWindow({ from: customWindow.from, to: customWindow.to, granularity: g });
      return res.json({ range: 'dia', labels, values, lastUpdated: latest.ts, from: customWindow.from.toISOString(), to: customWindow.to.toISOString(), granularity: g });
    } catch (err: any) {
      const code = String(err?.message ?? 'error');
      if (code === 'too_large') return res.status(400).json({ message: 'Intervalo demasiado grande para a granularidade escolhida.' });
      if (code === 'invalid_range') return res.status(400).json({ message: 'Intervalo inválido (from deve ser < to).' });
      return res.status(400).json({ message: 'Não foi possível gerar a série para o intervalo.' });
    }
  }

  if (range === 'dia') {
    const parsedDay = dateRaw ? parseDayKey(dateRaw) : null;
    const dayStart = parsedDay?.dayStart ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayEnd = parsedDay?.dayEnd ?? new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const g = granularity ?? '15m';
    try {
      const { labels, values } = await buildSeriesByWindow({ from: dayStart, to: dayEnd, granularity: g });
      return res.json({ range: 'dia', labels, values, lastUpdated: latest.ts, date: toDayKeyUtc(dayStart), granularity: g });
    } catch {
      return res.status(400).json({ message: 'Não foi possível gerar a série diária.' });
    }
  }

  if (range === 'semana') {
    const windowDays = days ?? 7;
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const start = addUtcDays(end, -windowDays);
    const actual = await sumByDay(start, end);

    const labels = Array.from({ length: windowDays }, (_, i) => {
      const dt = addUtcDays(start, i);
      return toDayKeyUtc(dt);
    });

    const values = labels.map((dayKey) => Number(((actual.get(dayKey) ?? 0)).toFixed(2)));
    return res.json({ range: 'semana', labels, values, lastUpdated: latest.ts, days: windowDays });
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

  const telRows = await c.customerTelemetry15m
    .find({ customer_id: customerId, ts: startMatch as any }, { projection: { _id: 0, ts: 1, watts: 1 } })
    .sort({ ts: 1 })
    .toArray();

  const points = (telRows as any[]).map((r) => ({ ts: new Date(r.ts), watts: Number(r.watts ?? 0) }));
  const priceEurPerKwh = typeof (customer as any)?.price_eur_per_kwh === 'number' ? Number((customer as any).price_eur_per_kwh) : 0.2;

  let inferred:
    | {
        appliances: Array<{ id: number; name: string; category: string | null; costEur: number; energyKwh: number; sessions: number; confidence: number }>;
        sessions: Array<any>;
      }
    | null = null;

  try {
    const fpRows = await c.customerNilmFingerprints
      .find({ customer_id: customerId }, { projection: { _id: 0 } })
      .sort({ updated_at: -1 })
      .limit(250)
      .toArray();

    const labelRows = await c.customerNilmSessions
      .find({ customer_id: customerId, label: { $ne: null } }, { projection: { _id: 0, id: 1, label: 1 } })
      .sort({ updated_at: -1 })
      .limit(600)
      .toArray();

    const labelsBySessionId = new Map<string, string | null>();
    for (const r of labelRows as any[]) labelsBySessionId.set(String(r.id), r.label ? String(r.label) : null);

    const { baselineWatts, sessions } = extractNilmSessions15m(points);
    const baselineKwh = (Math.max(0, baselineWatts) * points.length * 0.25) / 1000;

    inferred = inferFromFingerprints({
      customerId,
      sessions,
      priceEurPerKwh,
      knownFingerprints: (fpRows as any[]) as CustomerNilmFingerprintDoc[],
      maxAppliances: 6,
      userLabelsBySessionId: labelsBySessionId,
      baselineKwh
    });

    // Best-effort persistência (mantém applianceIds estáveis entre /summary e /weekly)
    const now = new Date();
    if ((inferred as any)?.updatedFingerprints?.length) {
      c.customerNilmFingerprints
        .bulkWrite(
          (inferred as any).updatedFingerprints.map((fp: any) => ({
            updateOne: {
              filter: { customer_id: customerId, id: fp.id },
              update: { $set: fp, $setOnInsert: { created_at: fp.created_at ?? now } },
              upsert: true
            }
          })),
          { ordered: false }
        )
        .catch(() => null);
    }

    if ((inferred as any)?.sessions?.length) {
      c.customerNilmSessions
        .bulkWrite(
          (inferred as any).sessions.slice(0, 800).map((s: any) => ({
            updateOne: {
              filter: { customer_id: customerId, id: s.sessionId },
              update: {
                $set: {
                  id: s.sessionId,
                  customer_id: customerId,
                  start_ts: s.startTs,
                  end_ts: s.endTs,
                  features: {
                    duration_min: s.durationMin,
                    mean_watts: s.meanWatts,
                    peak_watts: s.peakWatts,
                    energy_wh: s.energyWh,
                    start_step_watts: s.startStepWatts,
                    start_hour_utc: s.startTs.getUTCHours(),
                    start_dow: (s.startTs.getUTCDay() + 6) % 7
                  },
                  fingerprint_id: s.fingerprintId,
                  inferred_name: s.inferredLabel,
                  inferred_category: null,
                  confidence: s.confidence,
                  label: s.userLabel,
                  updated_at: now
                },
                $setOnInsert: { created_at: now }
              },
              upsert: true
            }
          })),
          { ordered: false }
        )
        .catch(() => null);
    }
  } catch {
    inferred = null;
  }

  const inferredFinal = (inferred ?? (inferAppliancesFromAggregate({ points, priceEurPerKwh, maxAppliances: 6 }) as any)) as {
    appliances: Array<{ id: number; name: string; category: string | null; costEur: number; energyKwh: number; sessions: number; confidence: number }>;
    sessions: Array<any>;
  };

  const itemsRaw = inferredFinal.appliances.map((a) => ({
    id: a.id,
    name: a.name,
    category: a.category,
    costEur: a.costEur,
    energyKwh: a.energyKwh,
    sessions: a.sessions,
    confidence: a.confidence,
    efficiencyScore: null,
    standbyWatts: null
  }));

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

  const improvedSuggestion = await Promise.race([
    llmImproveText({
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
    }),
    new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 1200))
    ]);
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

app.post('/customers/:customerId/nilm/sessions/:sessionId/label', async (req, res) => {
  const { customerId, sessionId } = req.params;
  if (!/^[a-f0-9]{8,64}$/i.test(sessionId)) return res.status(400).json({ message: 'sessionId inválido' });

  const schema = z.object({ label: z.string().max(80).nullable().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });

  const rawLabel = typeof parsed.data.label === 'string' ? parsed.data.label.trim() : null;
  const label = rawLabel ? rawLabel : null;

  const c = await collections();
  const existing = await c.customerNilmSessions.findOne({ customer_id: customerId, id: sessionId }, { projection: { _id: 0, id: 1 } });
  if (!existing) return res.status(404).json({ message: 'Sessão NILM não encontrada (aguarde o worker ou reabra a janela de tempo)' });

  const now = new Date();
  await c.customerNilmSessions.updateOne(
    { customer_id: customerId, id: sessionId },
    {
      $set: {
        label,
        updated_at: now
      }
    }
  );

  return res.json({ ok: true, sessionId, label });
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

  // O equipamento é inferido a partir do consumo agregado; o `applianceId` vem do endpoint /summary.

  const latestTs = await getCustomerLatestTs(customerId);
  if (!latestTs) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const end = new Date(latestTs);
  const endDay = startOfUtcDay(end);
  const toExclusive = addUtcDays(endDay, 1);
  const start = addUtcDays(toExclusive, -windowDays);

  const telRows = await c.customerTelemetry15m
    .find({ customer_id: customerId, ts: { $gte: start, $lt: toExclusive } }, { projection: { _id: 0, ts: 1, watts: 1 } })
    .sort({ ts: 1 })
    .toArray();

  const price = await c.customers
    .findOne({ id: customerId }, { projection: { _id: 0, price_eur_per_kwh: 1 } })
    .then((r: any) => (typeof r?.price_eur_per_kwh === 'number' && Number.isFinite(r.price_eur_per_kwh) ? Number(r.price_eur_per_kwh) : 0.2))
    .catch(() => 0.2);

  const points = (telRows as any[]).map((r) => ({ ts: new Date(r.ts), watts: Number(r.watts ?? 0) }));

  // Stand-by (id=1): modela como baselineWatts distribuído por dia.
  if (applianceId === 1) {
    const { baselineWatts } = extractNilmSessions15m(points);
    const baselineKwhPerDay = (Math.max(0, baselineWatts) * 24) / 1000;
    const daily = Array.from({ length: windowDays }, (_, i) => {
      const day = toDayKeyUtc(addUtcDays(start, i));
      const kwh = baselineKwhPerDay;
      return { day, kwh: Number(kwh.toFixed(3)), costEur: Number((kwh * price).toFixed(2)) };
    });

    const thisTotalKwh = daily.reduce((acc, x) => acc + x.kwh, 0);
    const thisTotalCostEur = daily.reduce((acc, x) => acc + x.costEur, 0);

    return res.json({
      customerId,
      applianceId: 1,
      name: 'Consumo base (stand-by)',
      lastUpdated: end.toISOString(),
      days: windowDays,
      totalKwh: Number(thisTotalKwh.toFixed(3)),
      totalCostEur: Number(thisTotalCostEur.toFixed(2)),
      sharePct: 0,
      daily,
      tip: 'Stand-by é o consumo de base da casa. Para reduzir: desligue regletas à noite, retire carregadores e reveja equipamentos sempre ligados.'
    });
  }

  let inferred:
    | {
        appliances: Array<{ id: number; name: string; category: string | null; costEur: number; energyKwh: number; sessions: number; confidence: number }>;
        sessions: Array<any>;
      }
    | null = null;

  try {
    const fpRows = await c.customerNilmFingerprints
      .find({ customer_id: customerId }, { projection: { _id: 0 } })
      .sort({ updated_at: -1 })
      .limit(250)
      .toArray();

    const labelRows = await c.customerNilmSessions
      .find({ customer_id: customerId, label: { $ne: null } }, { projection: { _id: 0, id: 1, label: 1 } })
      .sort({ updated_at: -1 })
      .limit(600)
      .toArray();

    const labelsBySessionId = new Map<string, string | null>();
    for (const r of labelRows as any[]) labelsBySessionId.set(String(r.id), r.label ? String(r.label) : null);

    const { sessions } = extractNilmSessions15m(points);
    inferred = inferFromFingerprints({
      customerId,
      sessions,
      priceEurPerKwh: price,
      knownFingerprints: (fpRows as any[]) as CustomerNilmFingerprintDoc[],
      maxAppliances: 10,
      userLabelsBySessionId: labelsBySessionId
    });
  } catch {
    inferred = null;
  }

  const inferredFinal = (inferred ?? (inferAppliancesFromAggregate({ points, priceEurPerKwh: price, maxAppliances: 6 }) as any)) as {
    appliances: Array<{ id: number; name: string; category: string | null; costEur: number; energyKwh: number; sessions: number; confidence: number }>;
    sessions: Array<any>;
  };

  let appliance = inferredFinal.appliances.find((a) => a.id === applianceId) ?? null;
  let sessions = inferredFinal.sessions.filter((s) => s.applianceId === applianceId);

  // Se o equipamento não aparecer nesta janela (ex.: não foi usado nos últimos 7 dias),
  // ainda assim devolvemos 200 com dados a zero, usando meta inferida numa janela maior.
  if (!appliance) {
    const fallbackStart = addUtcDays(toExclusive, -Math.max(30, windowDays));
    const tel30 = await c.customerTelemetry15m
      .find({ customer_id: customerId, ts: { $gte: fallbackStart, $lt: toExclusive } }, { projection: { _id: 0, ts: 1, watts: 1 } })
      .sort({ ts: 1 })
      .toArray();

    const points30 = (tel30 as any[]).map((r) => ({ ts: new Date(r.ts), watts: Number(r.watts ?? 0) }));

    let inferred30:
      | {
          appliances: Array<{ id: number; name: string; category: string | null; costEur: number; energyKwh: number; sessions: number; confidence: number }>;
          sessions: Array<any>;
        }
      | null = null;

    try {
      const fpRows = await c.customerNilmFingerprints
        .find({ customer_id: customerId }, { projection: { _id: 0 } })
        .sort({ updated_at: -1 })
        .limit(250)
        .toArray();

      const { sessions } = extractNilmSessions15m(points30);
      inferred30 = inferFromFingerprints({
        customerId,
        sessions,
        priceEurPerKwh: price,
        knownFingerprints: (fpRows as any[]) as CustomerNilmFingerprintDoc[],
        maxAppliances: 12
      });
    } catch {
      inferred30 = null;
    }

    const inferred30Final = (inferred30 ?? (inferAppliancesFromAggregate({ points: points30, priceEurPerKwh: price, maxAppliances: 10 }) as any)) as {
      appliances: Array<{ id: number; name: string; category: string | null; costEur: number; energyKwh: number; sessions: number; confidence: number }>;
      sessions: Array<any>;
    };

    appliance = inferred30Final.appliances.find((a: any) => a.id === applianceId) ?? null;
    sessions = inferred30Final.sessions.filter((s: any) => s.applianceId === applianceId);
  }

  if (!appliance) return res.status(404).json({ message: 'Equipamento não encontrado' });
  const totalCostEur = inferredFinal.appliances.reduce((acc, a) => acc + a.costEur, 0);

  const dailyByDay = new Map<string, { energyWh: number; costEur: number }>();
  for (const s of sessions) {
    const day = toDayKeyUtc(s.startTs);
    const prev = dailyByDay.get(day) ?? { energyWh: 0, costEur: 0 };
    dailyByDay.set(day, { energyWh: prev.energyWh + s.energyWh, costEur: prev.costEur + s.costEur });
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
  // sessões inferidas pelo NILM

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

  for (const s of sessions) {
    distributeSession(s.startTs, s.endTs, Number(s.energyWh ?? 0));
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
  const categoryLower = String(appliance.category ?? '').toLowerCase();
  const isFlexible =
    nameLower.includes('lavar') ||
    nameLower.includes('máquina') ||
    nameLower.includes('sec') ||
    nameLower.includes('loiça') ||
    nameLower.includes('carreg') ||
    categoryLower.includes('laundry');

  const standbyWatts: number | null = null;

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

  const improvedTip = await Promise.race([
    llmImproveText({
      kind: 'appliance_weekly_tip',
      customer: baseContext.customer,
      context: buildAssistantEnvelope({
        base: baseContext,
        extra: {
          appliance: { id: applianceId, name: appliance.name, category: appliance.category ?? null, standbyWatts },
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
    }),
    new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 1200))
  ]);
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

  const alert: null | { title: string; message: string; severity: 'info' | 'warning' | 'critical' } = null;

  return res.json({
    customerId,
    lastUpdated: end.toISOString(),
    devices,
    alert
  });
});

// Controlo manual (teste) - Shelly no Wi-Fi: candeeiro
function getShellyTopic(which: 1 | 2): string | null {
  const direct = String(process.env[`SHELLY_MQTT_TOPIC_${which}`] ?? '').trim();
  if (direct) return direct;
  if (which === 1) {
    const legacy = String(process.env.SHELLY_MQTT_TOPIC ?? '').trim();
    return legacy || null;
  }
  return null;
}

function getTomadaLabel(which: 1 | 2) {
  return `tomada ${which}`;
}

function shellyErrorPayload(device: string, err: unknown) {
  const code = (err as any)?.code ? String((err as any).code) : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return {
    device,
    state: 'unknown' as const,
    ack: false,
    mode: 'mqtt' as const,
    error: { code, message }
  };
}

app.get('/customers/:customerId/security/kynex-node/tomada/:which', async (req, res) => {
  const whichRaw = String(req.params.which ?? '').trim();
  const whichNum = Number(whichRaw);
  if (whichNum !== 1 && whichNum !== 2) return res.status(400).json({ message: 'which deve ser 1|2' });

  const which = whichNum as 1 | 2;
  const device = getTomadaLabel(which);
  const topic = getShellyTopic(which);
  if (!topic) return res.json({ ...shellyErrorPayload(device, { code: 'SHELLY_TOPIC_NOT_CONFIGURED' }), mode: 'mqtt' });

  try {
    const mqttConfigured = isShellyMqttConfigured({ topic });
    // eslint-disable-next-line no-console
    console.log(`[TOMADA ${which} GET] MQTT configured:`, mqttConfigured);

    if (!mqttConfigured) return res.json({ ...shellyErrorPayload(device, { code: 'SHELLY_MQTT_NOT_CONFIGURED' }), mode: 'mqtt' });

    const st = await shellySwitchGetStatus({ topic });
    // eslint-disable-next-line no-console
    console.log(`[TOMADA ${which} GET] MQTT status:`, st);
    return res.json({ device, state: st.on ? 'on' : 'off', ack: st.ack, mode: 'mqtt' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[TOMADA ${which} GET] Error:`, err instanceof Error ? err.message : String(err));
    return res.json(shellyErrorPayload(device, err));
  }
});

app.post('/customers/:customerId/security/kynex-node/tomada/:which', async (req, res) => {
  const whichRaw = String(req.params.which ?? '').trim();
  const whichNum = Number(whichRaw);
  if (whichNum !== 1 && whichNum !== 2) return res.status(400).json({ message: 'which deve ser 1|2' });

  const which = whichNum as 1 | 2;
  const device = getTomadaLabel(which);
  const topic = getShellyTopic(which);
  if (!topic) return res.json({ ...shellyErrorPayload(device, { code: 'SHELLY_TOPIC_NOT_CONFIGURED' }), mode: 'mqtt' });

  const turnRaw = (typeof req.query.turn === 'string' ? req.query.turn : undefined) ?? (req.body?.turn as string | undefined);
  const turn = String(turnRaw ?? '').trim().toLowerCase();
  if (turn !== 'on' && turn !== 'off') return res.status(400).json({ message: 'turn deve ser on|off' });

  try {
    // eslint-disable-next-line no-console
    console.log(`[TOMADA ${which} POST] turn requested:`, turn);

    const mqttConfigured = isShellyMqttConfigured({ topic });
    // eslint-disable-next-line no-console
    console.log(`[TOMADA ${which} POST] MQTT configured:`, mqttConfigured);

    if (!mqttConfigured) return res.json({ ...shellyErrorPayload(device, { code: 'SHELLY_MQTT_NOT_CONFIGURED' }), mode: 'mqtt' });

    const st = await shellySwitchSet(turn === 'on', { topic });
    // eslint-disable-next-line no-console
    console.log(`[TOMADA ${which} POST] MQTT set result:`, st);
    return res.json({ device, state: st.on ? 'on' : 'off', ack: st.ack, mode: 'mqtt' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[TOMADA ${which} POST] Error:`, err instanceof Error ? err.message : String(err));
    return res.json(shellyErrorPayload(device, err));
  }
});

app.get('/customers/:customerId/security/kynex-node/candeeiro', async (_req, res) => {
  try {
    const topic = getShellyTopic(1);
    const mqttConfigured = topic ? isShellyMqttConfigured({ topic }) : false;
    // eslint-disable-next-line no-console
    console.log('[CANDEEIRO GET] MQTT configured:', mqttConfigured);

    if (mqttConfigured) {
      const st = await shellySwitchGetStatus({ topic: topic ?? undefined });
      // eslint-disable-next-line no-console
      console.log('[CANDEEIRO GET] MQTT status:', st);
      return res.json({ device: 'candeeiro', state: st.on ? 'on' : 'off', ack: st.ack, mode: 'mqtt' });
    }

    // eslint-disable-next-line no-console
    console.log('[CANDEEIRO GET] Tentando HTTP request...');
    const r = await shellyRequest('/relay/0', { timeoutMs: 50000 });
    // eslint-disable-next-line no-console
    console.log('[CANDEEIRO GET] HTTP response:', { ok: r.ok, status: r.status, json: r.json });

    if (!r.ok) return res.status(502).json({ message: 'SHELLY_UNAVAILABLE', status: r.status });
    const isOn = Boolean(r.json?.ison ?? r.json?.isOn ?? r.json?.state);
    return res.json({ device: 'candeeiro', state: isOn ? 'on' : 'off', mode: 'http' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[CANDEEIRO GET] Error:', err instanceof Error ? err.message : String(err));
    return res.status(502).json({ message: 'SHELLY_UNAVAILABLE', error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/customers/:customerId/security/kynex-node/candeeiro', async (req, res) => {
  const turnRaw = (typeof req.query.turn === 'string' ? req.query.turn : undefined) ?? (req.body?.turn as string | undefined);
  const turn = String(turnRaw ?? '').trim().toLowerCase();
  if (turn !== 'on' && turn !== 'off') return res.status(400).json({ message: 'turn deve ser on|off' });

  try {
    // eslint-disable-next-line no-console
    console.log('[CANDEEIRO POST] turn requested:', turn);

    const topic = getShellyTopic(1);
    const mqttConfigured = topic ? isShellyMqttConfigured({ topic }) : false;
    // eslint-disable-next-line no-console
    console.log('[CANDEEIRO POST] MQTT configured:', mqttConfigured);

    if (mqttConfigured) {
      const st = await shellySwitchSet(turn === 'on', { topic: topic ?? undefined });
      // eslint-disable-next-line no-console
      console.log('[CANDEEIRO POST] MQTT set result:', st);
      return res.json({ device: 'candeeiro', state: st.on ? 'on' : 'off', ack: st.ack, mode: 'mqtt' });
    }

    // eslint-disable-next-line no-console
    console.log('[CANDEEIRO POST] Tentando HTTP request...');
    const r = await shellyRequest(`/relay/0?turn=${encodeURIComponent(turn)}`, { timeoutMs: 5000 });
    // eslint-disable-next-line no-console
    console.log('[CANDEEIRO POST] HTTP response:', { ok: r.ok, status: r.status, json: r.json });

    if (!r.ok) return res.status(502).json({ message: 'SHELLY_UNAVAILABLE', status: r.status });

    // alguns firmwares devolvem JSON; se não, assumimos o estado pedido
    const isOn = typeof r.json?.ison === 'boolean' ? r.json.ison : turn === 'on';
    return res.json({ device: 'candeeiro', state: isOn ? 'on' : 'off', mode: 'http' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[CANDEEIRO POST] Error:', err instanceof Error ? err.message : String(err));
    return res.status(502).json({ message: 'SHELLY_UNAVAILABLE', error: err instanceof Error ? err.message : String(err) });
  }
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

  let marketComparison: any = null;
  try {
    const latestInvoice = await c.customerInvoices
      .find(
        { customer_id: customerId },
        {
          projection: {
            _id: 0,
            analysis: 1,
            uploaded_at: 1,
            potencia_contratada_kva: 1,
            price_kwh_eur: 1,
            fixed_daily_fee_eur: 1
          }
        }
      )
      .sort({ uploaded_at: -1 })
      .limit(1)
      .toArray();

    const hasInvoice = Boolean(latestInvoice[0]);
    const contractedPowerKva = typeof customer.contracted_power_kva === 'number' ? customer.contracted_power_kva : hasInvoice ? Number((latestInvoice[0] as any)?.potencia_contratada_kva ?? 0) : 0;
    const currentPriceKwhEur = typeof customer.price_eur_per_kwh === 'number' ? customer.price_eur_per_kwh : hasInvoice ? Number((latestInvoice[0] as any)?.price_kwh_eur ?? 0) : 0;
    const currentFixedDailyFeeEur = typeof customer.fixed_daily_fee_eur === 'number' ? customer.fixed_daily_fee_eur : hasInvoice ? Number((latestInvoice[0] as any)?.fixed_daily_fee_eur ?? 0) : 0;

    if (contractedPowerKva > 0 && currentPriceKwhEur > 0) {
      const cmp = await compareWithPublicTariffs({
        customerId,
        contractedPowerKva,
        currentPriceKwhEur,
        currentFixedDailyFeeEur
      });

      marketComparison = {
        consumption_kwh_year: cmp.consumptionKwhYear,
        current_cost_year_eur: cmp.currentCostYearEur,
        best_cost_year_eur: cmp.bestCostYearEur,
        savings_year_eur: cmp.savingsYearEur,
        top: cmp.top.map((t) => ({
          comercializador: t.comercializador,
          nome_proposta: t.nomeProposta,
          cost_year_eur: t.costYearEur,
          savings_year_eur: t.savingsYearEur
        }))
      };
    }
  } catch {
    marketComparison = null;
  }

  return res.json({
    customerId,
    lastUpdated: endIso,
    contractedPowerKva: Number((customer.contracted_power_kva ?? 0).toFixed(1)),
    avgPriceEurPerKwh: Number(avgPrice.toFixed(4)),
    fixedDailyFeeEur: Number(fixedDailyFeeEur.toFixed(4)),
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
    },
    marketComparison
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

app.get('/customers/:customerId/invoices', async (req, res) => {
  const { customerId } = req.params;
  const c = await collections();
  const rows = await c.customerInvoices
    .find(
      { customer_id: customerId },
      {
        projection: {
          _id: 0,
          id: 1,
          filename: 1,
          mime_type: 1,
          size_bytes: 1,
          uploaded_at: 1,
          file_present: 1,
          utility_guess: 1,
          extracted_text: 1,
          valor_pagar_eur: 1,
          potencia_contratada_kva: 1,
          termo_energia_eur: 1,
          termo_potencia_eur: 1,
          analysis: 1
        }
      }
    )
    .sort({ uploaded_at: -1 })
    .limit(50)
    .toArray();

  // best-effort: corrigir totals claramente errados sem exigir novo upload
  // (não devolvemos extracted_text no payload)
  const { extractLikelyInvoiceTotalEur } = await import('./invoiceEngine');

  const items = await Promise.all(
    rows.map(async (r: any) => {
      try {
        const current = typeof r.valor_pagar_eur === 'number' && Number.isFinite(r.valor_pagar_eur) ? r.valor_pagar_eur : null;
        const shouldRecalc = (current === null || current < 10) && typeof r.extracted_text === 'string' && r.extracted_text.length > 50;

        if (shouldRecalc) {
          const recalced = extractLikelyInvoiceTotalEur(r.extracted_text);
          if (typeof recalced === 'number' && Number.isFinite(recalced) && recalced > 0) {
            // Só atualiza se mudar de forma material (evita writes constantes)
            if (current === null || Math.abs(recalced - current) > 0.5) {
              await c.customerInvoices.updateOne({ customer_id: customerId, id: r.id }, { $set: { valor_pagar_eur: recalced } });
              r.valor_pagar_eur = recalced;
            }
          }
        }
      } catch {
        // ignora
      }

      const { extracted_text: _ignored, ...rest } = r;
      return { ...rest, uploaded_at: r.uploaded_at.toISOString() };
    })
  );

  return res.json({ items });
});

app.get('/customers/:customerId/invoices/:invoiceId', async (req, res) => {
  const { customerId, invoiceId } = req.params;
  const c = await collections();
  const row = await c.customerInvoices.findOne(
    { customer_id: customerId, id: invoiceId },
    {
      projection: {
        _id: 0,
        id: 1,
        filename: 1,
        mime_type: 1,
        size_bytes: 1,
        uploaded_at: 1,
        file_present: 1,
        utility_guess: 1,
        extracted_text: 1,
        valor_pagar_eur: 1,
        potencia_contratada_kva: 1,
        termo_energia_eur: 1,
        termo_potencia_eur: 1,
        price_kwh_eur: 1,
        fixed_daily_fee_eur: 1,
        analysis: 1
      }
    }
  );
  if (!row) return res.status(404).json({ message: 'Fatura não encontrada' });

  return res.json({
    ...row,
    uploaded_at: row.uploaded_at.toISOString()
  });
});

app.get('/customers/:customerId/invoices/:invoiceId/file', async (req, res) => {
  const { customerId, invoiceId } = req.params;
  const c = await collections();

  const row = await c.customerInvoices.findOne(
    { customer_id: customerId, id: invoiceId },
    {
      projection: {
        _id: 0,
        filename: 1,
        mime_type: 1,
        file_bytes: 1,
        files: 1
      }
    }
  );
  if (!row) return res.status(404).json({ message: 'Fatura não encontrada' });

  const raw = ((row as any).file_bytes ?? (row as any)?.files?.[0]?.file_bytes) as any;
  let bytes: Buffer | null = null;

  if (Buffer.isBuffer(raw)) {
    bytes = raw;
  } else if (raw && typeof raw === 'object') {
    // mongodb Binary tem normalmente value(true) -> Buffer
    if (typeof raw.value === 'function') {
      try {
        const v = raw.value(true);
        if (Buffer.isBuffer(v)) bytes = v;
      } catch {
        // ignore
      }
    }

    // fallback: algumas versões expõem .buffer
    if (!bytes && Buffer.isBuffer(raw.buffer)) bytes = raw.buffer;

    // typed arrays
    if (!bytes && ArrayBuffer.isView(raw)) {
      try {
        bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      } catch {
        // ignore
      }
    }
  }

  if (!bytes || bytes.length === 0) {
    return res.status(404).json({ message: 'Ficheiro da fatura não disponível' });
  }

  const filename = String((row as any).filename ?? 'fatura').replace(/[\r\n"]/g, '');
  const mimeType = String((row as any).mime_type ?? 'application/octet-stream');

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  res.setHeader('Content-Length', String(bytes.length));
  return res.status(200).send(bytes);
});

app.post(
  '/customers/:customerId/invoices',
  invoiceUpload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'files', maxCount: 10 }
  ]),
  async (req, res) => {
  const { customerId } = req.params;

  type MulterFile = { originalname: string; mimetype: string; buffer: Buffer; size: number; fieldname?: string };
  const anyReq = req as any;

  const collected: MulterFile[] = [];
  if (anyReq?.file) collected.push(anyReq.file as MulterFile);
  const fobj = anyReq?.files;
  if (Array.isArray(fobj)) {
    collected.push(...(fobj as MulterFile[]));
  } else if (fobj && typeof fobj === 'object') {
    const maybeFiles = ([] as MulterFile[])
      .concat(Array.isArray((fobj as any).files) ? (fobj as any).files : [])
      .concat(Array.isArray((fobj as any).file) ? (fobj as any).file : []);
    collected.push(...maybeFiles);
  }

  const files = collected.filter((f) => f && Buffer.isBuffer(f.buffer) && f.buffer.length > 0);
  if (!files.length) return res.status(400).json({ message: 'Ficheiro(s) em falta (campo multipart: files)' });

  const c = await collections();
  const customer = await c.customers.findOne(
    { id: customerId },
    { projection: { _id: 0, id: 1, utility: 1, contracted_power_kva: 1, price_eur_per_kwh: 1, fixed_daily_fee_eur: 1 } }
  );
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });


  const extracted =
    files.length === 1
      ? await extractInvoiceFromFile({
          buffer: files[0].buffer,
          filename: files[0].originalname,
          mimeType: files[0].mimetype
        })
      : await extractInvoiceFromFiles({
          files: files.map((f) => ({ buffer: f.buffer, filename: f.originalname, mimeType: f.mimetype }))
        });

  // DEBUG: Printar todos os dados extraídos da fatura
  try {
    const debugObj = {
      ...extracted,
      extractedText: extracted.extractedText?.slice(0, 800) + (extracted.extractedText?.length > 800 ? '... (truncado)' : '')
    };
    // eslint-disable-next-line no-console
    console.log('[FATURA][EXTRACTED]', JSON.stringify(debugObj, null, 2));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[FATURA][EXTRACTED][ERROR]', e);
  }

  const invoiceId = newInvoiceId();
  const uploadedAt = new Date();

  const totalSizeBytes = files.reduce((acc, f) => acc + Number(f.size ?? 0), 0);
  const storedFilename = files.length === 1 ? files[0].originalname : `Fatura (${files.length} anexos)`;
  const storedMime = files.length === 1 ? files[0].mimetype : String(files[0].mimetype ?? 'application/octet-stream');

  const contractedPowerKva = extracted.potenciaContratadaKva ?? (customer as any).contracted_power_kva ?? null;
  const currentPriceKwh = extracted.priceKwhEur ?? (customer as any).price_eur_per_kwh ?? null;
  const currentFixedDaily = extracted.fixedDailyFeeEur ?? (customer as any).fixed_daily_fee_eur ?? null;

  // best-effort: se a fatura trouxer potência/preços, atualiza o perfil do cliente
  const customerUpdates: Record<string, any> = {};
  const powerTol = Number(process.env.KYNEX_POWER_TOL_KVA ?? 0.11);
  if (typeof extracted.potenciaContratadaKva === 'number' && Number.isFinite(extracted.potenciaContratadaKva)) {
    const prev = Number((customer as any).contracted_power_kva);
    if (!Number.isFinite(prev) || Math.abs(prev - extracted.potenciaContratadaKva) > powerTol) {
      customerUpdates.contracted_power_kva = extracted.potenciaContratadaKva;
    }
  }
  if (typeof extracted.priceKwhEur === 'number' && Number.isFinite(extracted.priceKwhEur)) {
    const prev = Number((customer as any).price_eur_per_kwh);
    if (!Number.isFinite(prev) || Math.abs(prev - extracted.priceKwhEur) > 0.0001) {
      customerUpdates.price_eur_per_kwh = extracted.priceKwhEur;
    }
  }
  if (typeof extracted.fixedDailyFeeEur === 'number' && Number.isFinite(extracted.fixedDailyFeeEur)) {
    const prev = Number((customer as any).fixed_daily_fee_eur);
    if (!Number.isFinite(prev) || Math.abs(prev - extracted.fixedDailyFeeEur) > 0.0001) {
      customerUpdates.fixed_daily_fee_eur = extracted.fixedDailyFeeEur;
    }
  }

  if (typeof extracted.utilityGuess === 'string' && extracted.utilityGuess.trim()) {
    const prev = String((customer as any).utility ?? '').trim();
    if (!prev || prev.toLowerCase() !== extracted.utilityGuess.toLowerCase()) {
      customerUpdates.utility = extracted.utilityGuess;
    }
  }
  if (Object.keys(customerUpdates).length) {
    c.customers.updateOne({ id: customerId }, { $set: customerUpdates }).catch(() => null);
  }

  let analysis: any = null;
  if (
    typeof contractedPowerKva === 'number' &&
    Number.isFinite(contractedPowerKva) &&
    typeof currentPriceKwh === 'number' &&
    Number.isFinite(currentPriceKwh) &&
    typeof currentFixedDaily === 'number' &&
    Number.isFinite(currentFixedDaily)
  ) {
    const cmp = await compareWithPublicTariffs({
      customerId,
      contractedPowerKva,
      currentPriceKwhEur: currentPriceKwh,
      currentFixedDailyFeeEur: currentFixedDaily
    });
    analysis = {
      consumption_kwh_year: cmp.consumptionKwhYear,
      current_cost_year_eur: cmp.currentCostYearEur,
      best_cost_year_eur: cmp.bestCostYearEur,
      savings_year_eur: cmp.savingsYearEur,
      top: cmp.top.map((t) => ({
        comercializador: t.comercializador,
        nome_proposta: t.nomeProposta,
        cost_year_eur: t.costYearEur,
        savings_year_eur: t.savingsYearEur
      }))
    };
  }

  const maxText = Math.max(1_000, Math.min(200_000, Number(process.env.KYNEX_MAX_INVOICE_TEXT_CHARS ?? 80_000)));
  const extractedText = extracted.extractedText.length > maxText ? extracted.extractedText.slice(0, maxText) : extracted.extractedText;

  await c.customerInvoices.insertOne({
    id: invoiceId,
    customer_id: customerId,
    filename: storedFilename,
    mime_type: storedMime,
    size_bytes: totalSizeBytes,
    uploaded_at: uploadedAt,
    file_bytes: files[0].buffer,
    file_present: true,
    files:
      files.length > 1
        ? files.map((f) => ({ filename: f.originalname, mime_type: f.mimetype, size_bytes: f.size, file_bytes: f.buffer }))
        : undefined,
    utility_guess: extracted.utilityGuess ?? undefined,
    extracted_text: extractedText,
    valor_pagar_eur: extracted.valorPagarEur ?? undefined,
    consumption_kwh_period: extracted.consumptionKwhPeriod ?? undefined,
    potencia_contratada_kva: extracted.potenciaContratadaKva ?? undefined,
    termo_energia_eur: extracted.termoEnergiaEur ?? undefined,
    termo_potencia_eur: extracted.termoPotenciaEur ?? undefined,
    price_kwh_eur: extracted.priceKwhEur ?? undefined,
    fixed_daily_fee_eur: extracted.fixedDailyFeeEur ?? undefined,
    analysis
  });

  return res.status(201).json({
    id: invoiceId,
    uploadedAt: uploadedAt.toISOString(),
    filesCount: files.length,
    customerUpdated: Object.keys(customerUpdates).length ? customerUpdates : null,
    extracted: {
      valorPagarEur: extracted.valorPagarEur,
      consumptionKwhPeriod: extracted.consumptionKwhPeriod,
      potenciaContratadaKva: extracted.potenciaContratadaKva,
      termoEnergiaEur: extracted.termoEnergiaEur,
      termoPotenciaEur: extracted.termoPotenciaEur,
      priceKwhEur: extracted.priceKwhEur,
      fixedDailyFeeEur: extracted.fixedDailyFeeEur,
      usedOcr: extracted.debug.usedOcr
    },
    analysis
  });
}
);

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

  // Resumo heurístico (sem LLM): 2–4 frases a partir dos melhores insights.
  const assistantText = (() => {
    const t0 = out[0]?.text ? String(out[0].text).trim() : '';
    const t1 = out[1]?.text ? String(out[1].text).trim() : '';
    const t2 = out[2]?.text ? String(out[2].text).trim() : '';

    const parts = [t0, t1].filter(Boolean);
    if (!parts.length) return null;

    // Próxima ação: pega na primeira frase do melhor insight.
    const next = t0.split(/[.!?]\s/)[0]?.trim();
    const summary = parts.join(' ').replace(/\s+/g, ' ').trim();
    const withNext = next && next.length >= 8 ? `${summary} Próxima ação: ${next}.` : summary;

    // Proteção de tamanho (UI e logs)
    return withNext.length <= 420 ? withNext : withNext.slice(0, 420);
  })();

  return res.json({
    customerId,
    lastUpdated: end.toISOString(),
    tips: out,
    assistantText
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

  const pickStandardKvaAtOrAbove = (targetKva: number) => {
    const sorted = standardKvaOptions.slice().sort((a, b) => a - b);
    for (const v of sorted) {
      if (v >= targetKva - 1e-9) return v;
    }
    return sorted[sorted.length - 1] ?? 60;
  };

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

    // IMPORTANTE: para estimar risco, NÃO devemos “capar” previsões ao candidate kVA.
    // Caso contrário o risco tende a ~0% mesmo quando o consumo real excede largamente.
    const observedPeakWatts = Math.max(
      Number(stats30.peakWatts ?? 0),
      Number(peak365.peakWatts ?? 0),
      Number(latestSample.watts ?? 0)
    );
    const hardCapWatts = Math.max(60_000, observedPeakWatts * 2);

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
          const predictedWatts = Math.max(20, Math.min(hardCapWatts, predictedRaw));
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

  // Não faz sentido sugerir potência abaixo do pico real observado.
  // Usamos o pico anual como mínimo (convertido para capWatts=0.92*kVA*1000).
  const minAllowedKva = Number(peak365.peakWatts ?? 0) > 0 ? pickStandardKvaAtOrAbove((Number(peak365.peakWatts) / (1000 * 0.92)) * 1.03) : 1.15;

  const candidates = Array.from(
    new Set([
      ...standardKvaOptions,
      contractedKva,
      clampSuggestedPowerKva(suggestedKva)
    ].map((v) => round1(v)))
  )
    .filter((v) => v >= minAllowedKva - 1e-9)
    .sort((a, b) => a - b);

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

  suggestedKva = round1(Math.max(best?.candidateKva ?? suggestedKva, minAllowedKva));

  const ratio = contractedKva > 0 ? suggestedKva / contractedKva : 1;
  const status = ratio <= 0.85 ? 'sobredimensionado' : ratio >= 1.1 ? 'subdimensionado' : 'ok';

  const current = await scoreCandidate(Math.max(1.15, contractedKva || suggestedKva));
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
