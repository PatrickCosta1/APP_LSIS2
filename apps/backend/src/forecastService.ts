import { getIpmaAvgTempForDate, getIpmaDailyForecast, resolveIpmaGlobalIdLocal } from './ipma';

export type DailyKwhPoint = { day: string; kwh: number; avgTempC: number | null };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
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

function dayOfYearUtc(d: Date) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / (24 * 60 * 60 * 1000));
}

function ridgeFit(x: number[][], y: number[], l2: number) {
  const n = Math.max(1, x.length);
  const d = x[0]?.length ?? 0;
  const mean = Array.from({ length: d }, () => 0);
  const std = Array.from({ length: d }, () => 0);

  for (const row of x) for (let j = 0; j < d; j += 1) mean[j] += row[j] ?? 0;
  for (let j = 0; j < d; j += 1) mean[j] /= n;

  for (const row of x) {
    for (let j = 0; j < d; j += 1) {
      const v = (row[j] ?? 0) - mean[j]!;
      std[j] += v * v;
    }
  }
  for (let j = 0; j < d; j += 1) {
    const s = Math.sqrt(std[j]! / Math.max(1, n - 1));
    std[j] = s > 1e-9 ? s : 1;
  }

  const xz = x.map((row) => row.map((v, j) => (((v ?? 0) - mean[j]!) / std[j]!) as number));
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  const yc = y.map((v) => v - yMean);

  const xtx = Array.from({ length: d }, () => Array.from({ length: d }, () => 0));
  const xty = Array.from({ length: d }, () => 0);

  for (let i = 0; i < n; i += 1) {
    const row = xz[i]!;
    const yi = yc[i]!;
    for (let a = 0; a < d; a += 1) {
      xty[a] += row[a]! * yi;
      for (let b = 0; b < d; b += 1) xtx[a]![b] += row[a]! * row[b]!;
    }
  }

  for (let j = 0; j < d; j += 1) xtx[j]![j] += l2;

  // Gauss-Jordan
  const aug = xtx.map((row, i) => [...row, ...Array.from({ length: d }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < d; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < d; r += 1) {
      if (Math.abs(aug[r]![col]!) > Math.abs(aug[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(aug[pivot]![col]!) < 1e-12) break;
    if (pivot !== col) {
      const tmp = aug[col]!;
      aug[col] = aug[pivot]!;
      aug[pivot] = tmp;
    }

    const pv = aug[col]![col]!;
    for (let j = 0; j < 2 * d; j += 1) aug[col]![j] = aug[col]![j]! / pv;

    for (let r = 0; r < d; r += 1) {
      if (r === col) continue;
      const factor = aug[r]![col]!;
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = 0; j < 2 * d; j += 1) aug[r]![j] = aug[r]![j]! - factor * aug[col]![j]!;
    }
  }

  const inv = aug.map((row) => row.slice(d));
  const weights = inv.map((row) => row.reduce((acc, v, i) => acc + v * xty[i]!, 0));
  const bias = yMean;

  return { weights, bias, mean, std };
}

function ridgePredict(model: { weights: number[]; bias: number; mean: number[]; std: number[] }, row: number[]) {
  let sum = model.bias;
  for (let j = 0; j < model.weights.length; j += 1) {
    const xz = ((row[j] ?? 0) - model.mean[j]!) / (model.std[j]! || 1);
    sum += xz * (model.weights[j] ?? 0);
  }
  return sum;
}

function makeDailyFeatures(day: Date, tempC: number | null, kwhYesterday: number, trend: number) {
  const dow = (day.getUTCDay() + 6) % 7;
  const doy = dayOfYearUtc(day);
  const hourRad = 2 * Math.PI * ((doy % 365) / 365);
  const dowRad = 2 * Math.PI * (dow / 7);

  const isWeekend = dow >= 5 ? 1 : 0;
  const t = typeof tempC === 'number' ? tempC : 16;

  return [
    kwhYesterday,
    Math.sin(dowRad),
    Math.cos(dowRad),
    Math.sin(hourRad),
    Math.cos(hourRad),
    isWeekend,
    t,
    trend
  ];
}

export async function buildDailyKwhWithWeather(opts: {
  customerId: string;
  end: Date;
  daysBack: number;
  city: string | null;
  readDailyKwh: (customerId: string, start: Date, endExclusive: Date) => Promise<Array<{ day: string; kwh: number }>>;
}) {
  const endDay = startOfUtcDay(opts.end);
  const start = addUtcDays(endDay, -Math.max(7, Math.min(365, opts.daysBack)));

  const series = await opts.readDailyKwh(opts.customerId, start, addUtcDays(endDay, 1));

  const globalIdLocal = await resolveIpmaGlobalIdLocal(opts.city ?? undefined);
  const forecast = await getIpmaDailyForecast(globalIdLocal);

  const out: DailyKwhPoint[] = series.map((p) => {
    const temp = forecast ? getIpmaAvgTempForDate(forecast, p.day) : null;
    return { day: p.day, kwh: p.kwh, avgTempC: temp };
  });

  return { points: out, ipmaOk: Boolean(forecast) };
}

export async function forecastMonth(opts: {
  customerId: string;
  end: Date;
  city: string | null;
  monthToDateKwh: number;
  priceEurPerKwh: number;
  fixedDailyFeeEur: number;
  readDailyKwh: (customerId: string, start: Date, endExclusive: Date) => Promise<Array<{ day: string; kwh: number }>>;
}) {
  const endDay = startOfUtcDay(opts.end);
  const monthStart = startOfUtcMonth(opts.end);
  const nextMonthStart = startOfNextUtcMonth(opts.end);

  // histórico: até 180 dias (se existir)
  const historyDays = 180;
  const historyStart = addUtcDays(endDay, -historyDays);

  const { points, ipmaOk } = await buildDailyKwhWithWeather({
    customerId: opts.customerId,
    end: opts.end,
    daysBack: historyDays,
    city: opts.city,
    readDailyKwh: opts.readDailyKwh
  });

  // treino: usa dias completos antes de endDay
  const train = points.filter((p) => p.day < toDayKeyUtc(endDay) && p.kwh >= 0);

  // fallback se pouco histórico
  const remainingDays = Math.max(0, (nextMonthStart.getTime() - opts.end.getTime()) / (24 * 60 * 60 * 1000));

  if (train.length < 10) {
    const avg = train.length ? train.reduce((a, b) => a + b.kwh, 0) / train.length : Math.max(0.1, opts.monthToDateKwh / Math.max(1, opts.end.getUTCDate()));
    const forecastKwh = Math.max(opts.monthToDateKwh, opts.monthToDateKwh + avg * remainingDays);
    const cost = forecastKwh * opts.priceEurPerKwh + opts.fixedDailyFeeEur * (opts.end.getUTCDate() + remainingDays);
    return {
      method: 'fallback_recent_avg',
      ipmaOk,
      forecastMonthKwh: Number(forecastKwh.toFixed(2)),
      forecastMonthEuros: Number(cost.toFixed(2)),
      lowKwh: Number((forecastKwh * 0.9).toFixed(2)),
      highKwh: Number((forecastKwh * 1.1).toFixed(2))
    };
  }

  // monta dataset com features (lag + sazonalidade + temperatura)
  const byDay = new Map(train.map((p) => [p.day, p]));
  const sortedDays = train.map((p) => p.day).sort();

  const x: number[][] = [];
  const y: number[] = [];

  for (let i = 1; i < sortedDays.length; i += 1) {
    const day = sortedDays[i]!;
    const prev = byDay.get(sortedDays[i - 1]!)!;
    const cur = byDay.get(day)!;

    const dt = new Date(`${day}T00:00:00.000Z`);
    const trend = i / sortedDays.length;
    x.push(makeDailyFeatures(dt, cur.avgTempC, prev.kwh, trend));
    y.push(cur.kwh);
  }

  // Ridge com regularização forte para não overfit (poucos dados)
  const model = ridgeFit(x, y, 2.0);

  // previsão dia-a-dia até fim do mês
  const monthEndExclusive = nextMonthStart;

  const globalIdLocal = await resolveIpmaGlobalIdLocal(opts.city ?? undefined);
  const ipmaForecast = await getIpmaDailyForecast(globalIdLocal);

  // seed: último dia conhecido
  const lastKnown = byDay.get(sortedDays[sortedDays.length - 1]!)!;
  let lastKwh = lastKnown.kwh;

  let forecastRemainKwh = 0;
  const forecasts: number[] = [];

  let cursor = addUtcDays(endDay, 1);
  let step = 0;
  while (cursor.getTime() < monthEndExclusive.getTime()) {
    const ymd = toDayKeyUtc(cursor);
    const temp = ipmaForecast ? getIpmaAvgTempForDate(ipmaForecast, ymd) : lastKnown.avgTempC;
    const trend = 1 + step / Math.max(1, remainingDays);

    const pred = ridgePredict(model, makeDailyFeatures(cursor, temp, lastKwh, trend));
    const kwh = clamp(pred, 0, Math.max(0.8, lastKwh * 1.8));

    forecasts.push(kwh);
    forecastRemainKwh += kwh;
    lastKwh = kwh;
    cursor = addUtcDays(cursor, 1);
    step += 1;
  }

  const forecastMonthKwh = Math.max(opts.monthToDateKwh, opts.monthToDateKwh + forecastRemainKwh);

  // banda (P10/P90) baseada em resíduos do treino
  const predsTrain = x.map((row) => ridgePredict(model, row));
  const residuals = predsTrain.map((p, i) => y[i]! - p).sort((a, b) => a - b);
  const q = (p: number) => {
    const idx = Math.floor((residuals.length - 1) * p);
    return residuals[Math.max(0, Math.min(residuals.length - 1, idx))] ?? 0;
  };
  const r10 = q(0.1);
  const r90 = q(0.9);

  const lowRemain = forecasts.reduce((acc, v) => acc + clamp(v + r10, 0, v * 1.6), 0);
  const highRemain = forecasts.reduce((acc, v) => acc + clamp(v + r90, 0, v * 1.8), 0);

  const lowKwh = Math.max(opts.monthToDateKwh, opts.monthToDateKwh + lowRemain);
  const highKwh = Math.max(lowKwh, opts.monthToDateKwh + highRemain);

  const daysTotal = opts.end.getUTCDate() + remainingDays;
  const euros = forecastMonthKwh * opts.priceEurPerKwh + opts.fixedDailyFeeEur * daysTotal;

  return {
    method: 'ridge_daily_temp_seasonality_lag',
    ipmaOk: Boolean(ipmaForecast) || ipmaOk,
    forecastMonthKwh: Number(forecastMonthKwh.toFixed(2)),
    forecastMonthEuros: Number(euros.toFixed(2)),
    lowKwh: Number(lowKwh.toFixed(2)),
    highKwh: Number(highKwh.toFixed(2))
  };
}
