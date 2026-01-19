import fs from 'fs';
import path from 'path';

export type RidgeModel = {
  version: number;
  trained_at: string;
  l2: number;
  feature_names: string[];
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
  metrics?: { mae?: number; rmse?: number; r2?: number };
};

export type PowerCustomer = {
  segment: 'residential' | 'sme' | 'industrial' | string;
  contracted_power_kva: number;
  home_area_m2?: number;
  household_size?: number;
  has_solar?: number;
  ev_count?: number;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const getPowerModelPath = () => {
  // Em runtime (dist), __dirname = apps/backend/dist
  return path.join(__dirname, '..', 'data', 'ai_power_model.json');
};

export const loadPowerModel = (): RidgeModel | null => {
  const modelPath = getPowerModelPath();
  if (!fs.existsSync(modelPath)) return null;
  const raw = fs.readFileSync(modelPath, 'utf-8');
  return JSON.parse(raw) as RidgeModel;
};

export const makePowerFeatures = (customer: PowerCustomer, peakWatts30d: number, avgWatts30d: number): number[] => {
  const homeArea = typeof customer.home_area_m2 === 'number' ? customer.home_area_m2 : 90;
  const householdSize = typeof customer.household_size === 'number' ? customer.household_size : 2;
  const hasSolar = typeof customer.has_solar === 'number' ? customer.has_solar : 0;
  const evCount = typeof customer.ev_count === 'number' ? customer.ev_count : 0;

  const segRes = customer.segment === 'residential' ? 1 : 0;
  const segSme = customer.segment === 'sme' ? 1 : 0;
  const segInd = customer.segment === 'industrial' ? 1 : 0;

  return [
    customer.contracted_power_kva,
    peakWatts30d,
    avgWatts30d,
    homeArea,
    householdSize,
    hasSolar,
    evCount,
    segRes,
    segSme,
    segInd
  ];
};

export const predictRidge = (model: RidgeModel, features: number[]): number => {
  const d = model.feature_names.length;
  if (features.length !== d) {
    throw new Error(`Feature mismatch: expected ${d}, got ${features.length}`);
  }

  let sum = model.bias;
  for (let j = 0; j < d; j += 1) {
    const std = model.std[j] || 1;
    const mean = model.mean[j] || 0;
    const xz = (features[j] - mean) / std;
    sum += xz * model.weights[j];
  }

  return sum;
};

export const clampSuggestedPowerKva = (suggested: number) => {
  // limites práticos
  return clamp(suggested, 1, 60);
};
