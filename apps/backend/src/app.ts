import cors from 'cors';
import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getCollections, initDb, type Collections } from './db';
import { clampPredictionForCustomer, loadAiModel, makeFeatures, predictNextWatts, type CustomerProfile } from './ai';
import { clampSuggestedPowerKva, loadPowerModel, makePowerFeatures, predictRidge } from './powerAi';

const app = express();

app.use(cors());
app.use(express.json());

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
    { projection: { _id: 0, id: 1, name: 1, segment: 1, home_area_m2: 1, price_eur_per_kwh: 1 } }
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

  return res.json({
    customerId: customer.id,
    name: customer.name,
    lastUpdated: latest.ts,
    wattsNow: latest.watts,
    avgWattsLastHour: Number(avgWatts1h.toFixed(1)),
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
    const actual = await sumByDay(weekStart, weekEnd);
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
        if (aiModel.feature_names.length !== featCount) throw new Error('feature mismatch');

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

app.post('/ai/customers', async (req, res) => {
  console.log('POST /ai/customers payload:', JSON.stringify(req.body));
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
  if (!parsed.success) {
    console.error('POST /ai/customers schema error:', JSON.stringify(parsed.error.flatten().fieldErrors));
    return res.status(400).json({ errors: parsed.error.flatten().fieldErrors });
  }

  const id = `U_${crypto.randomUUID()}`;
  const createdAt = new Date();
  const c = parsed.data;
  console.log('POST /ai/customers parsed data:', JSON.stringify(c));

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

  try {
    const cols = await collections();
    await cols.customers.insertOne({
      id,
      name: c.name,
      segment: c.segment,
      city: c.city,
      contracted_power_kva: c.contracted_power_kva,
      tariff: c.tariff,
      utility: c.utility,

      home_area_m2: c.home_area_m2 ?? 80,
      household_size: c.household_size ?? 2,
      locality_type: c.locality_type ?? 'Urbana',
      dwelling_type: c.dwelling_type ?? 'Apartamento',
      build_year_band: c.build_year_band ?? '2000-2014',
      heating_sources: toCsv(c.heating_sources),

      has_solar: toInt01(c.has_solar, 0),
      ev_count: c.ev_count ?? 0,
      has_smart_meter: toInt01(c.has_smart_meter, 1),
      price_eur_per_kwh: c.price_eur_per_kwh ?? RATE_EUR_PER_KWH,
      fixed_daily_fee_eur: c.fixed_daily_fee_eur ?? 0,

      alert_sensitivity: c.alert_sensitivity ?? 'Média',
      main_appliances: toCsv(c.main_appliances),

      created_at: createdAt
    });
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
