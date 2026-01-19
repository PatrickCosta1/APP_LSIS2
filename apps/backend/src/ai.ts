import fs from 'fs';
import path from 'path';

export type RidgeAiModel = {
  type?: 'ridge';
  version: number;
  trained_at: string;
  interval_minutes: number;
  l2: number;
  feature_names: string[];
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
  metrics?: { mae?: number; rmse?: number; r2?: number };
};

export type HourlyProfileAiModel = {
  type: 'hourly_profile';
  version: number;
  trained_at: string;
  interval_minutes: number;
  buckets_168: number[];
  global_mean: number;
  metrics?: { mae?: number; rmse?: number; r2?: number };
};

export type AiModel = RidgeAiModel | HourlyProfileAiModel;

export type CustomerProfile = {
  id: string;
  segment: 'residential' | 'sme' | 'industrial' | string;
  city: string;
  contracted_power_kva: number;
  tariff: 'Simples' | 'Bi-horário' | string;
  home_area_m2?: number;
  household_size?: number;
  has_solar?: number;
  ev_count?: number;
  price_eur_per_kwh?: number;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const getModelPath = () => {
  // Em runtime (dist), __dirname = apps/backend/dist
  return path.join(__dirname, '..', 'data', 'ai_model.json');
};

export const loadAiModel = (): AiModel | null => {
  const modelPath = getModelPath();
  if (!fs.existsSync(modelPath)) return null;

  const raw = fs.readFileSync(modelPath, 'utf-8');
  return JSON.parse(raw) as AiModel;
};

const seasonalTemperature = (ts: Date, city: string): number => {
  // Aproximação equivalente ao Python (sem ruído): sazonalidade anual + bias litoral
  const startOfYear = Date.UTC(ts.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((ts.getTime() - startOfYear) / (24 * 60 * 60 * 1000)) + 1;
  const base = 16.0 + 7.0 * Math.sin((2 * Math.PI * (dayOfYear - 170)) / 365.0);
  const coastBias = ['Porto', 'Matosinhos', 'Vila Nova de Gaia', 'Aveiro'].includes(city) ? -1.0 : 0.0;
  return base + coastBias;
};

export const makeFeatures = (ts: Date, customer: CustomerProfile, lastWatts: number, tempC?: number): number[] => {
  const hour = ts.getUTCHours() + ts.getUTCMinutes() / 60;
  const dow = (ts.getUTCDay() + 6) % 7; // JS: 0=Sunday -> 6; converte p/ 0=Mon
  const isWeekend = dow >= 5 ? 1 : 0;

  const hourRad = 2 * Math.PI * (hour / 24);
  const dowRad = 2 * Math.PI * (dow / 7);

  const temp = typeof tempC === 'number' ? tempC : seasonalTemperature(ts, customer.city);

  const tariffSimples = customer.tariff === 'Simples' ? 1 : 0;
  const tariffBihorario = customer.tariff === 'Bi-horário' ? 1 : 0;

  const segRes = customer.segment === 'residential' ? 1 : 0;
  const segSme = customer.segment === 'sme' ? 1 : 0;
  const segInd = customer.segment === 'industrial' ? 1 : 0;

  const homeArea = typeof customer.home_area_m2 === 'number' ? customer.home_area_m2 : 90;
  const householdSize = typeof customer.household_size === 'number' ? customer.household_size : 2;
  const hasSolar = typeof customer.has_solar === 'number' ? customer.has_solar : 0;
  const evCount = typeof customer.ev_count === 'number' ? customer.ev_count : 0;

  return [
    lastWatts,
    Math.sin(hourRad),
    Math.cos(hourRad),
    Math.sin(dowRad),
    Math.cos(dowRad),
    isWeekend,
    temp,
    customer.contracted_power_kva,
    tariffSimples,
    tariffBihorario,
    segRes,
    segSme,
    segInd,
    homeArea,
    householdSize,
    hasSolar,
    evCount
  ];
};

export const predictNextWatts = (model: AiModel, features: number[]): number => {
  if ((model as any)?.type === 'hourly_profile') {
    const m = model as HourlyProfileAiModel;
    const hourSin = features[1];
    const hourCos = features[2];
    const dowSin = features[3];
    const dowCos = features[4];

    const hourRad = Math.atan2(hourSin, hourCos);
    const hour01 = (hourRad < 0 ? hourRad + 2 * Math.PI : hourRad) / (2 * Math.PI);
    const hour = Math.floor(hour01 * 24) % 24;

    const dowRad = Math.atan2(dowSin, dowCos);
    const dow01 = (dowRad < 0 ? dowRad + 2 * Math.PI : dowRad) / (2 * Math.PI);
    const dow = Math.floor(dow01 * 7) % 7;

    const bucket = dow * 24 + hour;
    const pred = m.buckets_168[bucket];
    return Number.isFinite(pred) ? pred : m.global_mean;
  }

  const rm = model as RidgeAiModel;
  const d = rm.feature_names.length;
  if (features.length !== d) {
    throw new Error(`Feature mismatch: expected ${d}, got ${features.length}`);
  }

  let sum = rm.bias;
  for (let j = 0; j < d; j += 1) {
    const std = rm.std[j] || 1;
    const mean = rm.mean[j] || 0;
    const xz = (features[j] - mean) / std;
    sum += xz * (rm.weights[j] || 0);
  }

  return sum;
};

export const clampPredictionForCustomer = (watts: number, customer: CustomerProfile): number => {
  const cap = customer.contracted_power_kva * 1000 * 0.95;
  return clamp(watts, 20, cap);
};
