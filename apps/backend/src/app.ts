import cors from 'cors';
import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb } from './db';
import { clampPredictionForCustomer, loadAiModel, makeFeatures, predictNextWatts, type CustomerProfile } from './ai';
import { clampSuggestedPowerKva, loadPowerModel, makePowerFeatures, predictRidge } from './powerAi';

const app = express();

app.use(cors());
app.use(express.json());

const db = getDb();
const RATE_EUR_PER_KWH = 0.2;
const SAMPLE_INTERVAL_HOURS = 0.25; // 15m dos dados sintéticos

type ChartKind = 'consumido' | 'previsto';

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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/telemetry/now', (_req, res) => {
  const latest = db
    .prepare('SELECT ts, watts FROM samples ORDER BY ts DESC LIMIT 1')
    .get() as { ts: string; watts: number } | undefined;

  if (!latest) return res.status(404).json({ message: 'Sem dados' });

  const eurosPerHour = (latest.watts / 1000) * RATE_EUR_PER_KWH;
  const forecastMonthly = eurosPerHour * 24 * 30;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dayRows = db
    .prepare('SELECT watts FROM samples WHERE ts >= ?')
    .all(since) as Array<{ watts: number }>;
  const costDay = dayRows.reduce((acc, row) => acc + (row.watts / 1000) * RATE_EUR_PER_KWH * SAMPLE_INTERVAL_HOURS, 0);

  res.json({
    watts: latest.watts,
    eurosPerHour: Number(eurosPerHour.toFixed(3)),
    forecastMonthly: Number(forecastMonthly.toFixed(2)),
    costLast24h: Number(costDay.toFixed(2)),
    lastUpdated: latest.ts
  });
});

app.get('/telemetry/day', (_req, res) => {
  const rows = db.prepare('SELECT ts, watts FROM samples ORDER BY ts ASC LIMIT 96').all() as Array<{ ts: string; watts: number }>;

  const points = rows.map((r) => ({ ts: r.ts, watts: r.watts }));
  res.json(points);
});

app.get('/telemetry/range', (req, res) => {
  const { from, to, bucket = '15m' } = req.query as { from?: string; to?: string; bucket?: string };
  const end = to ?? new Date().toISOString();
  const start = from ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  if (bucket === '15m') {
    const rows = db
      .prepare('SELECT ts, watts, euros FROM telemetry_15m WHERE ts BETWEEN ? AND ? ORDER BY ts ASC')
      .all(start, end);
    return res.json(rows);
  }

  const rows = db
    .prepare('SELECT ts, watts, euros FROM samples WHERE ts BETWEEN ? AND ? ORDER BY ts ASC')
    .all(start, end);
  return res.json(rows);
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

const listEvents = () =>
  db
    .prepare('SELECT id, label, status, confidence, watts, duration_min, created_at FROM nilm_events ORDER BY created_at DESC')
    .all();

app.get('/events', (_req, res) => {
  res.json(listEvents());
});

app.get('/nilm/events', (_req, res) => {
  res.json(listEvents());
});

app.post('/events/:id/confirm', (req, res) => {
  const schema = z.object({ label: z.string().min(1).max(120) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });

  const { id } = req.params;
  const result = db
    .prepare('UPDATE nilm_events SET label = ?, status = ?, confidence = ? WHERE id = ?')
    .run(parsed.data.label, 'confirmed', 0.9, id);
  if (result.changes === 0) return res.status(404).json({ message: 'Evento não encontrado' });
  return res.json({ ok: true });
});

app.get('/alerts', (_req, res) => {
  const rows = db.prepare('SELECT id, message, severity, status, type, created_at FROM alerts ORDER BY created_at DESC').all();
  res.json(rows);
});

app.post('/alerts/:id/resolve', (req, res) => {
  const { id } = req.params;
  const result = db.prepare('UPDATE alerts SET status = ? WHERE id = ?').run('closed', id);
  if (result.changes === 0) return res.status(404).json({ message: 'Alerta não encontrado' });
  return res.json({ ok: true });
});

app.get('/appliances', (_req, res) => {
  const appliances = db
    .prepare('SELECT id, name, category, standby_watts, efficiency_score, annual_cost, created_at FROM appliances ORDER BY id ASC')
    .all();

  const usageByAppliance = db.prepare(
    'SELECT appliance_id, SUM(energy_wh) as energy_wh, SUM(cost_eur) as cost_eur FROM appliance_usage GROUP BY appliance_id'
  );

  const usage = usageByAppliance.all() as Array<{ appliance_id: number; energy_wh: number; cost_eur: number }>;
  const usageMap = Object.fromEntries(usage.map((u) => [u.appliance_id, u]));

  const withUsage = appliances.map((a: any) => ({
    ...a,
    usage_wh: usageMap[a.id]?.energy_wh ?? 0,
    usage_cost: usageMap[a.id]?.cost_eur ?? 0
  }));

  res.json(withUsage);
});

app.get('/appliances/:id/usage', (req, res) => {
  const { id } = req.params;
  const rows = db
    .prepare(
      'SELECT start_ts, end_ts, energy_wh, cost_eur, confidence FROM appliance_usage WHERE appliance_id = ? ORDER BY start_ts DESC'
    )
    .all(id);
  res.json(rows);
});

app.get('/advice/contract', (_req, res) => {
  const advice = db
    .prepare('SELECT id, current_power, suggested_power, tariff, savings_per_month, created_at FROM advice ORDER BY created_at DESC LIMIT 1')
    .get() as
    | {
        id: number;
        current_power: number;
        suggested_power: number;
        tariff: string;
        savings_per_month: number;
        created_at: string;
      }
    | undefined;

  if (!advice) {
    return res.json({
      current_power: 6.9,
      suggested_power: 5.75,
      tariff: 'Simples',
      savings_per_month: 0,
      created_at: new Date().toISOString()
    });
  }

  return res.json(advice);
});

app.get('/contract/profile', (_req, res) => {
  const profile = db
    .prepare('SELECT power_kva, tariff, utility, updated_at FROM contract_profile WHERE id = 1')
    .get() as { power_kva: number; tariff: string; utility: string; updated_at: string } | undefined;
  if (!profile) return res.status(404).json({ message: 'Perfil contratual não definido' });
  res.json(profile);
});

app.post('/contract/simulate', (req, res) => {
  const schema = z.object({ power_kva: z.number().min(1).max(20), tariff: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });

  const { power_kva, tariff } = parsed.data;
  const current = db.prepare('SELECT power_kva, tariff FROM contract_profile WHERE id = 1').get() as
    | { power_kva: number; tariff: string }
    | undefined;
  const deltaPower = current ? current.power_kva - power_kva : 0;
  const savings = deltaPower > 0 ? deltaPower * 1.2 : 0; // simplificado
  const tariffImpact = tariff !== current?.tariff ? 3 : 0;

  res.json({
    proposed: { power_kva, tariff },
    estimated_savings_month: Number((savings + tariffImpact).toFixed(2)),
    risk: deltaPower > 2 ? 'moderate' : 'low'
  });
});

app.get('/reports/monthly', (_req, res) => {
  const rows = db
    .prepare('SELECT day, kwh, euros, peak_watts FROM telemetry_daily ORDER BY day DESC LIMIT 12')
    .all();
  res.json(rows);
});

app.get('/customers/:customerId/telemetry/now', (req, res) => {
  const { customerId } = req.params;

  const customer = db
    .prepare(
      'SELECT id, name, segment, home_area_m2, price_eur_per_kwh FROM customers WHERE id = ?'
    )
    .get(customerId) as { id: string; name: string; segment: string; home_area_m2: number; price_eur_per_kwh: number } | undefined;
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latest = db
    .prepare('SELECT ts, watts, temp_c FROM customer_telemetry_15m WHERE customer_id = ? ORDER BY ts DESC LIMIT 1')
    .get(customerId) as { ts: string; watts: number; temp_c: number | null } | undefined;
  if (!latest) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  // Usa o "tempo simulado" (último ts gravado). Como o gerador acelera +15m por tick,
  // o relógio real pode ficar atrás e os somatórios ficarem congelados.
  const end = new Date(latest.ts);
  const endIso = end.toISOString();
  const since24h = new Date(end.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const since1h = new Date(end.getTime() - 60 * 60 * 1000).toISOString();

  const sum24h = db
    .prepare('SELECT COALESCE(SUM(watts), 0) as sumWatts FROM customer_telemetry_15m WHERE customer_id = ? AND ts BETWEEN ? AND ?')
    .get(customerId, since24h, endIso) as { sumWatts: number };
  const kwhLast24h = sumKwhFromSumWatts(sum24h.sumWatts ?? 0);

  const monthStart = startOfUtcMonthFromIso(endIso).toISOString();
  const sumMonth = db
    .prepare('SELECT COALESCE(SUM(watts), 0) as sumWatts FROM customer_telemetry_15m WHERE customer_id = ? AND ts BETWEEN ? AND ?')
    .get(customerId, monthStart, endIso) as { sumWatts: number };
  const monthToDateKwh = sumKwhFromSumWatts(sumMonth.sumWatts ?? 0);

  const price = typeof customer.price_eur_per_kwh === 'number' ? customer.price_eur_per_kwh : RATE_EUR_PER_KWH;
  const eurosLast24h = kwhLast24h * price;
  const monthToDateEuros = monthToDateKwh * price;

  // Previsão mensal simples: usa a média diária do último dia e projeta para o mês.
  // (1 tick = +15 min, então isto evolui com o tempo simulado.)
  const dim = daysInUtcMonthFromIso(endIso);
  const forecastMonthKwh = kwhLast24h * dim;
  const forecastMonthEuros = forecastMonthKwh * price;

  const avg1h = db
    .prepare('SELECT COALESCE(AVG(watts), 0) as avgWatts FROM customer_telemetry_15m WHERE customer_id = ? AND ts BETWEEN ? AND ?')
    .get(customerId, since1h, endIso) as { avgWatts: number };

  // comparação com casas semelhantes (segmento + área aproximada)
  const areaLow = customer.home_area_m2 * 0.7;
  const areaHigh = customer.home_area_m2 * 1.3;
  const similarRows = db
    .prepare(
      `SELECT c.id as id, COALESCE(SUM(t.watts), 0) as sumWatts
       FROM customers c
       JOIN customer_telemetry_15m t ON t.customer_id = c.id
       WHERE c.id <> ? AND c.segment = ? AND c.home_area_m2 BETWEEN ? AND ? AND t.ts BETWEEN ? AND ?
       GROUP BY c.id`
    )
    .all(customerId, customer.segment, areaLow, areaHigh, since24h, endIso) as Array<{ id: string; sumWatts: number }>;

  let similarKwhLast24h = 0;
  if (similarRows.length) {
    const kwhs = similarRows.map((r) => sumKwhFromSumWatts(r.sumWatts ?? 0));
    similarKwhLast24h = kwhs.reduce((a, b) => a + b, 0) / kwhs.length;
  } else {
    similarKwhLast24h = kwhLast24h * 1.15;
  }
  const similarDeltaPct = similarKwhLast24h > 0 ? ((kwhLast24h / similarKwhLast24h) - 1) * 100 : 0;

  return res.json({
    customerId: customer.id,
    name: customer.name,
    lastUpdated: latest.ts,
    wattsNow: latest.watts,
    avgWattsLastHour: Number((avg1h.avgWatts ?? 0).toFixed(1)),
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

app.get('/customers/:customerId/chart', (req, res) => {
  const { customerId } = req.params;
  const range = (req.query.range as string | undefined) ?? 'dia';
  if (!['dia', 'semana', 'mes'].includes(range)) {
    return res.status(400).json({ message: 'range inválido (dia|semana|mes)' });
  }

  const customer = db
    .prepare(
      'SELECT id, segment, city, contracted_power_kva, tariff, home_area_m2, household_size, has_solar, ev_count, price_eur_per_kwh FROM customers WHERE id = ?'
    )
    .get(customerId) as CustomerProfile | undefined;
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latest = db
    .prepare('SELECT ts, watts, temp_c FROM customer_telemetry_15m WHERE customer_id = ? ORDER BY ts DESC LIMIT 1')
    .get(customerId) as { ts: string; watts: number; temp_c: number | null } | undefined;
  if (!latest) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  // Tal como no /telemetry/now, usar o tempo simulado do último ponto.
  const now = new Date(latest.ts);

  const sumByDay = (from: Date, to: Date) => {
    const rows = db
      .prepare(
        `SELECT substr(ts, 1, 10) as day, COALESCE(SUM(watts), 0) as sumWatts
         FROM customer_telemetry_15m
         WHERE customer_id = ? AND ts BETWEEN ? AND ?
         GROUP BY substr(ts, 1, 10)`
      )
      .all(customerId, from.toISOString(), to.toISOString()) as Array<{ day: string; sumWatts: number }>;
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.day, sumKwhFromSumWatts(r.sumWatts ?? 0));
    return map;
  };

  const buildPredictedKwhByDay = (toExclusive: Date) => {
    const model = loadAiModel();
    if (!model) return new Map<string, number>();

    try {
      const featCount = makeFeatures(new Date(latest.ts), customer, latest.watts, latest.temp_c ?? undefined).length;
      if (model.feature_names.length !== featCount) return new Map<string, number>();
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
    const actual = sumByDay(weekStart, weekEnd);
    const predicted = buildPredictedKwhByDay(weekEnd);

    const todayKey = toDayKeyUtc(now);

    const items = labels.map((label, idx) => {
      const dayKey = toDayKeyUtc(addUtcDays(weekStart, idx));
      const kind: ChartKind = dayKey > todayKey ? 'previsto' : 'consumido';
      const value = kind === 'previsto' ? (predicted.get(dayKey) ?? 0) : (actual.get(dayKey) ?? 0);
      return { label, value: Number(value.toFixed(2)), kind };
    });

    return res.json({ title: 'Consumo', items });
  }

  if (range === 'semana') {
    const labels = ['S1', 'S2', 'S3', 'S4'];
    const monthStart = startOfUtcMonth(now);
    const monthEnd = startOfNextUtcMonth(now);
    const actual = sumByDay(monthStart, monthEnd);
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

  const items = labels.map((label, i) => {
    const offset = (span - 1) - i;
    const start = startOfUtcMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1)));
    const end = startOfNextUtcMonth(start);
    const m = sumByDay(start, end);
    let sum = 0;
    for (const v of m.values()) sum += v;
    return { label, value: Number(sum.toFixed(2)), kind: 'consumido' as const };
  });

  return res.json({ title: 'Consumo', items });
});

app.get('/customers/:customerId/analytics/consumption', (req, res) => {
  const { customerId } = req.params;
  const range = (req.query.range as string | undefined) ?? 'semana';
  if (!['semana', 'mes'].includes(range)) {
    return res.status(400).json({ message: 'range inválido (semana|mes)' });
  }

  const customer = db
    .prepare('SELECT id FROM customers WHERE id = ?')
    .get(customerId) as { id: string } | undefined;
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latest = db
    .prepare('SELECT ts FROM customer_telemetry_15m WHERE customer_id = ? ORDER BY ts DESC LIMIT 1')
    .get(customerId) as { ts: string } | undefined;
  if (!latest) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const now = new Date(latest.ts);

  const sumByDay = (from: Date, to: Date) => {
    const rows = db
      .prepare(
        `SELECT substr(ts, 1, 10) as day, COALESCE(SUM(watts), 0) as sumWatts
         FROM customer_telemetry_15m
         WHERE customer_id = ? AND ts BETWEEN ? AND ?
         GROUP BY substr(ts, 1, 10)`
      )
      .all(customerId, from.toISOString(), to.toISOString()) as Array<{ day: string; sumWatts: number }>;
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.day, sumKwhFromSumWatts(r.sumWatts ?? 0));
    return map;
  };

  if (range === 'semana') {
    const labels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
    const weekStart = startOfUtcWeekMonday(now);
    const weekEnd = addUtcDays(weekStart, 7);
    const actual = sumByDay(weekStart, weekEnd);

    const values = labels.map((_, idx) => {
      const dayKey = toDayKeyUtc(addUtcDays(weekStart, idx));
      return Number(((actual.get(dayKey) ?? 0)).toFixed(2));
    });

    return res.json({ range: 'semana', labels, values, lastUpdated: latest.ts });
  }

  // mes: do dia 1 ao último dia do mês do "tempo simulado" (latest.ts)
  const monthStart = startOfUtcMonth(now);
  const monthEnd = startOfNextUtcMonth(now);
  const actual = sumByDay(monthStart, monthEnd);
  const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  const labels = Array.from({ length: dim }, (_, i) => `${i + 1}`);
  const values = labels.map((_, idx) => {
    const day = addUtcDays(monthStart, idx);
    const dayKey = toDayKeyUtc(day);
    return Number(((actual.get(dayKey) ?? 0)).toFixed(2));
  });

  return res.json({ range: 'mes', labels, values, lastUpdated: latest.ts });
});

app.get('/customers/:customerId/power/suggestion', (req, res) => {
  const { customerId } = req.params;

  const customer = db
    .prepare(
      'SELECT id, segment, contracted_power_kva, home_area_m2, household_size, has_solar, ev_count, price_eur_per_kwh, fixed_daily_fee_eur, tariff FROM customers WHERE id = ?'
    )
    .get(customerId) as {
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
  } | undefined;
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latest = db
    .prepare('SELECT ts FROM customer_telemetry_15m WHERE customer_id = ? ORDER BY ts DESC LIMIT 1')
    .get(customerId) as { ts: string } | undefined;
  if (!latest) return res.status(404).json({ message: 'Sem telemetria para este cliente' });

  const end = new Date(latest.ts);
  const endIso = end.toISOString();
  const since30d = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const since365d = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();

  const stats30 = db
    .prepare(
      'SELECT COALESCE(MAX(watts), 0) as peakWatts, COALESCE(AVG(watts), 0) as avgWatts FROM customer_telemetry_15m WHERE customer_id = ? AND ts BETWEEN ? AND ?'
    )
    .get(customerId, since30d, endIso) as { peakWatts: number; avgWatts: number };

  const peak365 = db
    .prepare(
      'SELECT COALESCE(MAX(watts), 0) as peakWatts FROM customer_telemetry_15m WHERE customer_id = ? AND ts BETWEEN ? AND ?'
    )
    .get(customerId, since365d, endIso) as { peakWatts: number };

  const contractedKva = Number(customer.contracted_power_kva ?? 0);
  const yearlyPeakKva = round1((Number(peak365.peakWatts ?? 0) / 1000));
  const usagePctOfContracted = contractedKva > 0 ? Math.round((yearlyPeakKva / contractedKva) * 100) : 0;

  // Histórico: probabilidade de exceder um cap (com base em amostras 15m)
  const count30 = db
    .prepare(
      'SELECT COUNT(*) as n FROM customer_telemetry_15m WHERE customer_id = ? AND ts BETWEEN ? AND ?'
    )
    .get(customerId, since30d, endIso) as { n: number };

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
  const kwhLast24h = (() => {
    const since24h = new Date(end.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const sum24h = db
      .prepare('SELECT COALESCE(SUM(watts), 0) as sumWatts FROM customer_telemetry_15m WHERE customer_id = ? AND ts BETWEEN ? AND ?')
      .get(customerId, since24h, endIso) as { sumWatts: number };
    return sumKwhFromSumWatts(sum24h.sumWatts ?? 0);
  })();
  const forecastMonthKwh = kwhLast24h * dim;

  const fixedDailyFee = typeof customer.fixed_daily_fee_eur === 'number' ? customer.fixed_daily_fee_eur : 0;
  const feePerKvaPerDay = contractedKva > 0 ? fixedDailyFee / contractedKva : 0;

  const aiModel = loadAiModel();
  const latestRow = db
    .prepare('SELECT ts, watts, temp_c FROM customer_telemetry_15m WHERE customer_id = ? ORDER BY ts DESC LIMIT 1')
    .get(customerId) as { ts: string; watts: number; temp_c: number | null };

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

  const estimateFutureExceedProb = (candidateKva: number) => {
    const capWatts = candidateKva * 1000 * 0.92;

    // Se tivermos modelo de consumo, simulamos até ao fim do mês para estimar risco futuro.
    if (aiModel) {
      try {
        const featCount = makeFeatures(new Date(latestRow.ts), asCustomerProfile, latestRow.watts, latestRow.temp_c ?? undefined).length;
        if (aiModel.feature_names.length !== featCount) throw new Error('feature mismatch');

        const monthEnd = startOfNextUtcMonth(new Date(latestRow.ts));
        const intervalMinutes = aiModel.interval_minutes ?? 15;
        let ts = new Date(latestRow.ts);
        let lastWatts = latestRow.watts;

        let exceed = 0;
        let total = 0;
        const maxSteps = 31 * 96;
        let steps = 0;

        while (ts.getTime() < monthEnd.getTime() && steps < maxSteps) {
          ts = new Date(ts.getTime() + intervalMinutes * 60 * 1000);
          if (ts.getTime() >= monthEnd.getTime()) break;
          const feats = makeFeatures(ts, asCustomerProfile, lastWatts, latestRow.temp_c ?? undefined);
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
    const exceedRow = db
      .prepare(
        'SELECT COUNT(*) as n FROM customer_telemetry_15m WHERE customer_id = ? AND ts BETWEEN ? AND ? AND watts > ?'
      )
      .get(customerId, since30d, endIso, capWatts) as { n: number };
    return (Number(exceedRow.n ?? 0) / total);
  };

  const riskWeight = customer.segment === 'industrial' ? 120 : customer.segment === 'sme' ? 85 : 55;

  const candidates = Array.from(
    new Set([
      ...standardKvaOptions,
      contractedKva,
      clampSuggestedPowerKva(suggestedKva)
    ].map((v) => round1(v)))
  ).sort((a, b) => a - b);

  const scoreCandidate = (candidateKva: number) => {
    const exceedProb = clamp01(estimateFutureExceedProb(candidateKva));
    const powerFeeMonth = feePerKvaPerDay > 0 ? feePerKvaPerDay * candidateKva * dim : 0;
    const energyFeeMonth = forecastMonthKwh * priceEurPerKwh;

    // Penaliza fortemente riscos acima de 2%.
    const riskPenalty = riskWeight * Math.pow(exceedProb, 1.7) * (dim * 10);
    const score = powerFeeMonth + energyFeeMonth + riskPenalty;

    return { candidateKva, exceedProb, powerFeeMonth, energyFeeMonth, score };
  };

  const scored = candidates.map(scoreCandidate);
  scored.sort((a, b) => a.score - b.score);
  const best = scored[0];

  suggestedKva = round1(best?.candidateKva ?? suggestedKva);

  const ratio = contractedKva > 0 ? suggestedKva / contractedKva : 1;
  const status = ratio <= 0.85 ? 'sobredimensionado' : ratio >= 1.1 ? 'subdimensionado' : 'ok';

  const current = scoreCandidate(contractedKva || suggestedKva);
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

app.get('/ai/customers', (_req, res) => {
  const customers = db
    .prepare(
      'SELECT id, name, segment, city, contracted_power_kva, tariff, utility, price_eur_per_kwh, fixed_daily_fee_eur, has_smart_meter, home_area_m2, household_size, locality_type, dwelling_type, build_year_band, heating_sources, has_solar, ev_count, alert_sensitivity, main_appliances, created_at FROM customers ORDER BY created_at DESC'
    )
    .all();
  res.json(customers);
});

app.post('/ai/customers', (req, res) => {
  const schema = z.object({
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

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });

  const id = `U_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const c = parsed.data;

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

  db.prepare(
    `INSERT INTO customers (
      id, name, segment, city, contracted_power_kva, tariff, utility,
      home_area_m2, household_size, locality_type, dwelling_type, build_year_band, heating_sources,
      has_solar, ev_count, has_smart_meter, price_eur_per_kwh, fixed_daily_fee_eur, alert_sensitivity, main_appliances,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    c.name,
    c.segment,
    c.city,
    c.contracted_power_kva,
    c.tariff,
    c.utility,
    c.home_area_m2 ?? 80,
    c.household_size ?? 2,
    c.locality_type ?? 'Urbana',
    c.dwelling_type ?? 'Apartamento',
    c.build_year_band ?? '2000-2014',
    toCsv(c.heating_sources),
    toInt01(c.has_solar, 0),
    c.ev_count ?? 0,
    toInt01(c.has_smart_meter, 1),
    c.price_eur_per_kwh ?? RATE_EUR_PER_KWH,
    c.fixed_daily_fee_eur ?? 0,
    c.alert_sensitivity ?? 'Média',
    toCsv(c.main_appliances),
    createdAt
  );

  return res.status(201).json({ id });
});

app.get('/ai/forecast/:customerId', (req, res) => {
  const { customerId } = req.params;
  const horizonRaw = (req.query.horizon as string | undefined) ?? '1';
  const horizon = Math.max(1, Math.min(96, Number.parseInt(horizonRaw, 10) || 1));

  const model = loadAiModel();
  if (!model) return res.status(503).json({ message: 'Modelo não encontrado. Execute: py -3 apps/backend/ai_train.py' });

  const customer = db
    .prepare(
      'SELECT id, segment, city, contracted_power_kva, tariff, home_area_m2, household_size, has_solar, ev_count, price_eur_per_kwh FROM customers WHERE id = ?'
    )
    .get(customerId) as CustomerProfile | undefined;
  if (!customer) return res.status(404).json({ message: 'Cliente não encontrado' });

  const latest = db
    .prepare('SELECT ts, watts, temp_c FROM customer_telemetry_15m WHERE customer_id = ? ORDER BY ts DESC LIMIT 1')
    .get(customerId) as { ts: string; watts: number; temp_c: number | null } | undefined;
  if (!latest) {
    return res.status(404).json({ message: 'Sem telemetria para este cliente. Execute: py -3 apps/backend/ai_generate.py' });
  }

  try {
    const featureCount = makeFeatures(new Date(latest.ts), customer, latest.watts, latest.temp_c ?? undefined).length;
    if (model.feature_names.length !== featureCount) {
      return res.status(409).json({
        message: 'Modelo incompatível com as features atuais. Re-treine o modelo.',
        expectedFeatures: featureCount,
        modelFeatures: model.feature_names.length,
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
  const points = [] as Array<{ ts: string; predictedWatts: number; predictedKwh: number; predictedEuros: number }>;

  for (let i = 0; i < horizon; i += 1) {
    ts = new Date(ts.getTime() + intervalMinutes * 60 * 1000);
    const feats = makeFeatures(ts, customer, lastWatts, latest.temp_c ?? undefined);
    const predictedRaw = predictNextWatts(model, feats);
    const predictedWatts = clampPredictionForCustomer(predictedRaw, customer);
    const predictedKwh = (predictedWatts / 1000) * intervalHours;
    const predictedEuros = predictedKwh * rateEurPerKwh;
    points.push({
      ts: ts.toISOString(),
      predictedWatts: Math.round(predictedWatts),
      predictedKwh: Number(predictedKwh.toFixed(4)),
      predictedEuros: Number(predictedEuros.toFixed(4))
    });
    lastWatts = predictedWatts;
  }

  return res.json({
    customerId,
    horizon,
    intervalMinutes,
    lastObserved: { ts: latest.ts, watts: latest.watts },
    points
  });
});

export default app;
