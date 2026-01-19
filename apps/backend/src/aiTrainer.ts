import fs from 'fs';
import path from 'path';

import { getCollections, initDb, type Collections } from './db';
import {
  clampPredictionForCustomer,
  getModelPath,
  makeFeatures,
  predictNextWatts,
  type AiModel,
  type CustomerProfile
} from './ai';

const FEATURE_NAMES: AiModel['feature_names'] = [
  'last_watts',
  'hour_sin',
  'hour_cos',
  'dow_sin',
  'dow_cos',
  'is_weekend',
  'temp_c',
  'contracted_power_kva',
  'tariff_simples',
  'tariff_bihorario',
  'segment_residential',
  'segment_sme',
  'segment_industrial',
  'home_area_m2',
  'household_size',
  'has_solar',
  'ev_count'
];

type TelemetryDoc = {
  customer_id: string;
  ts: Date;
  watts: number;
  temp_c?: number | null;
};

let collectionsPromise: Promise<Collections> | null = null;
async function collections() {
  if (!collectionsPromise) {
    collectionsPromise = initDb().then(() => getCollections());
  }
  return collectionsPromise;
}

const dot = (a: number[], b: number[]) => a.reduce((acc, v, i) => acc + v * b[i]!, 0);

const identity = (n: number) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

const invertMatrix = (m: number[][]) => {
  const n = m.length;
  const aug = m.map((row, i) => [...row, ...identity(n)[i]!]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(aug[r]![col]!) > Math.abs(aug[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(aug[pivot]![col]!) < 1e-12) throw new Error('Matriz singular');
    if (pivot !== col) {
      const tmp = aug[col]!;
      aug[col] = aug[pivot]!;
      aug[pivot] = tmp;
    }

    const pv = aug[col]![col]!;
    for (let j = 0; j < 2 * n; j += 1) aug[col]![j] = aug[col]![j]! / pv;

    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = aug[r]![col]!;
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = 0; j < 2 * n; j += 1) {
        aug[r]![j] = aug[r]![j]! - factor * aug[col]![j]!;
      }
    }
  }

  return aug.map((row) => row.slice(n));
};

const standardize = (x: number[][]) => {
  const n = x.length;
  const d = x[0]!.length;
  const mean = Array.from({ length: d }, () => 0);
  const std = Array.from({ length: d }, () => 0);

  for (const row of x) {
    for (let j = 0; j < d; j += 1) mean[j] += row[j]!;
  }
  for (let j = 0; j < d; j += 1) mean[j] /= Math.max(1, n);

  for (const row of x) {
    for (let j = 0; j < d; j += 1) {
      const v = row[j]! - mean[j]!;
      std[j] += v * v;
    }
  }
  for (let j = 0; j < d; j += 1) {
    const s = Math.sqrt(std[j]! / Math.max(1, n - 1));
    std[j] = s > 1e-9 ? s : 1;
  }

  const xz = x.map((row) => row.map((v, j) => (v - mean[j]!) / std[j]!));
  return { xz, mean, std };
};

const ridgeFit = (x: number[][], y: number[], l2: number) => {
  const { xz, mean, std } = standardize(x);
  const n = xz.length;
  const d = xz[0]!.length;

  const yMean = y.reduce((a, b) => a + b, 0) / Math.max(1, n);
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

  const inv = invertMatrix(xtx);
  const weights = inv.map((row) => dot(row, xty));
  const bias = yMean;

  return { weights, bias, mean, std };
};

const metrics = (yTrue: number[], yPred: number[]) => {
  const n = Math.max(1, yTrue.length);
  const mae = yTrue.reduce((acc, yt, i) => acc + Math.abs(yt - yPred[i]!), 0) / n;
  const mse = yTrue.reduce((acc, yt, i) => {
    const e = yt - yPred[i]!;
    return acc + e * e;
  }, 0) / n;
  const rmse = Math.sqrt(mse);

  const meanY = yTrue.reduce((a, b) => a + b, 0) / n;
  const ssTot = yTrue.reduce((acc, yt) => {
    const d = yt - meanY;
    return acc + d * d;
  }, 0);
  const ssRes = yTrue.reduce((acc, yt, i) => {
    const d = yt - yPred[i]!;
    return acc + d * d;
  }, 0);
  const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : 0;

  return { mae: Number(mae.toFixed(2)), rmse: Number(rmse.toFixed(2)), r2: Number(r2.toFixed(3)) };
};

const shuffleInPlace = (arr: number[], seed = 42) => {
  let x = seed >>> 0;
  const rand = () => {
    // xorshift32
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };

  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
};

const predictRow = (model: Pick<AiModel, 'weights' | 'bias' | 'mean' | 'std' | 'feature_names'>, row: number[]) => {
  const d = model.feature_names.length;
  let sum = model.bias;
  for (let j = 0; j < d; j += 1) {
    const xz = (row[j]! - model.mean[j]!) / (model.std[j]! || 1);
    sum += xz * model.weights[j]!;
  }
  return sum;
};

const ensureDir = (filePath: string) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
};

export const trainConsumptionModelFromMongo = async (opts?: {
  days?: number;
  l2?: number;
  seed?: number;
  minSamples?: number;
}) => {
  const days = opts?.days ?? Number(process.env.KYNEX_AI_TRAIN_DAYS ?? 14);
  const l2 = opts?.l2 ?? Number(process.env.KYNEX_AI_L2 ?? 2.0);
  const seed = opts?.seed ?? Number(process.env.KYNEX_AI_SEED ?? 42);
  const minSamples = opts?.minSamples ?? Number(process.env.KYNEX_AI_MIN_SAMPLES ?? 250);

  const c = await collections();

  const customers = await c.customers
    .find(
      {},
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
    )
    .toArray();

  const byId = new Map<string, CustomerProfile>();
  for (const cust of customers) {
    byId.set(String(cust.id), {
      id: String(cust.id),
      segment: String(cust.segment ?? 'residential'),
      city: String(cust.city ?? 'Porto'),
      contracted_power_kva: Number(cust.contracted_power_kva ?? 6.9),
      tariff: String(cust.tariff ?? 'Simples'),
      home_area_m2: typeof cust.home_area_m2 === 'number' ? cust.home_area_m2 : undefined,
      household_size: typeof cust.household_size === 'number' ? cust.household_size : undefined,
      has_solar: typeof cust.has_solar === 'number' ? cust.has_solar : undefined,
      ev_count: typeof cust.ev_count === 'number' ? cust.ev_count : undefined,
      price_eur_per_kwh: typeof cust.price_eur_per_kwh === 'number' ? cust.price_eur_per_kwh : undefined
    });
  }

  const latestRow = await c.customerTelemetry15m
    .find({}, { projection: { _id: 0, ts: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  const latest = latestRow[0]?.ts;
  if (!latest) throw new Error('Sem telemetria para treinar');

  const end = new Date(latest);
  const since = new Date(end.getTime() - Math.max(1, days) * 24 * 60 * 60 * 1000);

  const cursor = c.customerTelemetry15m
    .find({ ts: { $gte: since, $lte: end } }, { projection: { _id: 0, customer_id: 1, ts: 1, watts: 1, temp_c: 1 } })
    .sort({ customer_id: 1, ts: 1 });

  const prevByCustomer = new Map<string, TelemetryDoc>();
  const x: number[][] = [];
  const y: number[] = [];

  for await (const raw of cursor as unknown as AsyncIterable<TelemetryDoc>) {
    const cid = String((raw as any).customer_id ?? '');
    if (!cid) continue;
    const profile = byId.get(cid);
    if (!profile) continue;

    const ts = new Date((raw as any).ts);
    const watts = Number((raw as any).watts ?? 0);
    const tempC = typeof (raw as any).temp_c === 'number' ? (raw as any).temp_c : undefined;

    const prev = prevByCustomer.get(cid);
    if (prev) {
      const feats = makeFeatures(new Date(prev.ts), profile, Number(prev.watts ?? 0), typeof (prev as any).temp_c === 'number' ? (prev as any).temp_c : undefined);
      x.push(feats);
      y.push(watts);
    }

    prevByCustomer.set(cid, { customer_id: cid, ts, watts, temp_c: tempC });
  }

  if (x.length < minSamples) {
    throw new Error(`Poucos dados para treinar (${x.length} amostras).`);
  }

  const idx = Array.from({ length: x.length }, (_, i) => i);
  shuffleInPlace(idx, seed);

  const split = Math.floor(idx.length * 0.8);
  const tr = idx.slice(0, split);
  const te = idx.slice(split);

  const xTr = tr.map((i) => x[i]!);
  const yTr = tr.map((i) => y[i]!);
  const xTe = te.map((i) => x[i]!);
  const yTe = te.map((i) => y[i]!);

  const fitted = ridgeFit(xTr, yTr, l2);

  const preds = xTe.map((row) =>
    predictRow(
      {
        feature_names: FEATURE_NAMES,
        weights: fitted.weights,
        bias: fitted.bias,
        mean: fitted.mean,
        std: fitted.std
      },
      row
    )
  );
  const m = metrics(yTe, preds);

  const model: AiModel = {
    version: 1,
    trained_at: new Date().toISOString(),
    interval_minutes: 15,
    l2,
    feature_names: FEATURE_NAMES,
    mean: fitted.mean,
    std: fitted.std,
    weights: fitted.weights,
    bias: fitted.bias,
    metrics: m
  };

  return { model, samples: x.length };
};

export const saveAiModelToDisk = (model: AiModel) => {
  const outPath = getModelPath();
  ensureDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(model, null, 2), 'utf-8');
  return outPath;
};

let retrainInProgress = false;
let lastResult:
  | { ok: true; trainedAt: string; samples: number; modelPath: string; metrics: AiModel['metrics'] }
  | { ok: false; at: string; error: string }
  | null = null;

export const getAiRetrainStatus = () => lastResult;

export const runAiRetrainOnce = async () => {
  if (retrainInProgress) return lastResult;
  retrainInProgress = true;
  try {
    const { model, samples } = await trainConsumptionModelFromMongo();
    const modelPath = saveAiModelToDisk(model);
    lastResult = { ok: true, trainedAt: model.trained_at, samples, modelPath, metrics: model.metrics };
    return lastResult;
  } catch (err) {
    lastResult = { ok: false, at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) };
    return lastResult;
  } finally {
    retrainInProgress = false;
  }
};

export const startAiRetrainJob = (opts?: { intervalMs?: number }) => {
  if (process.env.NODE_ENV === 'test') return;

  const enabledEnv = process.env.KYNEX_AI_AUTORETRAIN;
  const enabled = enabledEnv == null ? true : ['1', 'true', 'yes', 'on'].includes(String(enabledEnv).toLowerCase());
  if (!enabled) return;

  const intervalMs = opts?.intervalMs ?? Number(process.env.KYNEX_AI_RETRAIN_MS ?? 6 * 60 * 60 * 1000);
  const safeIntervalMs = Number.isFinite(intervalMs) && intervalMs >= 5 * 60 * 1000 ? intervalMs : 6 * 60 * 60 * 1000;

  // tenta 1x ao arranque, mas sem falhar a API
  runAiRetrainOnce().catch(() => {
    // ignore
  });

  setInterval(() => {
    runAiRetrainOnce().catch(() => {
      // ignore
    });
  }, safeIntervalMs);
};

export const isValidModelForRuntime = (model: AiModel | null) => {
  if (!model) return false;
  try {
    // sanity: uma previsão deve ser finita
    const fakeCustomer: CustomerProfile = {
      id: 'test',
      segment: 'residential',
      city: 'Porto',
      contracted_power_kva: 6.9,
      tariff: 'Simples'
    };
    const feats = makeFeatures(new Date(), fakeCustomer, 1200, 15);
    const y = predictNextWatts(model, feats);
    const clamped = clampPredictionForCustomer(y, fakeCustomer);
    return Number.isFinite(clamped);
  } catch {
    return false;
  }
};
