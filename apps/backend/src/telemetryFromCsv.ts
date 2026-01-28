import fs from 'node:fs';
import path from 'node:path';

export type CsvTelemetryRow = {
  meterId: string;
  ts: Date;
  kw: number;
  state: string;
};

function parsePtDecimal(raw: string) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  return Number(s.replace(/\./g, '').replace(',', '.'));
}

// O ficheiro `meusDados1Ano.csv` usa vírgula como separador e também como separador decimal.
// Exemplo linha: `...,00:15,0,164,Real` -> o valor kW fica repartido em 2 colunas.
// Por isso fazemos parsing manual: 1º=Contador, 2º=Data, 3º=Hora, último=Estado, e o resto junta-se para formar o número.
export function readTelemetry15mFromCsvFile(csvPath: string): CsvTelemetryRow[] {
  const abs = path.isAbsolute(csvPath) ? csvPath : path.resolve(process.cwd(), csvPath);
  const raw = fs.readFileSync(abs, 'utf-8');

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];

  const out: CsvTelemetryRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const parts = line.split(',');
    if (parts.length < 5) continue;

    const meterId = String(parts[0] ?? '').trim();
    const dateRaw = String(parts[1] ?? '').trim();
    const timeRaw = String(parts[2] ?? '').trim();
    const state = String(parts[parts.length - 1] ?? '').trim();
    const kwRawJoined = parts.slice(3, -1).join(',').trim();

    const m = dateRaw.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    const t = timeRaw.match(/^(\d{2}):(\d{2})$/);
    if (!m || !t) continue;

    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(t[1]);
    const minute = Number(t[2]);

    const kw = parsePtDecimal(kwRawJoined);
    if (!Number.isFinite(kw) || kw < 0) continue;

    const ts = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
    out.push({ meterId, ts, kw, state });
  }

  out.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return out;
}

export type ConsumptionSlotModel = {
  version: 1;
  trainedAt: string;
  meterId: string | null;
  // 7 dias x 96 slots
  slots: Array<{ samplesWatts: number[]; meanWatts: number; stdWatts: number }>;
  phi: number;
};

function mean(xs: number[]) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[], mu: number) {
  if (xs.length <= 1) return 0;
  const v = xs.reduce((acc, x) => acc + (x - mu) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function trainSlotModelFromCsv(rows: CsvTelemetryRow[]): ConsumptionSlotModel {
  const meterId = rows[0]?.meterId ? String(rows[0].meterId) : null;
  const buckets: number[][] = Array.from({ length: 7 * 96 }, () => []);

  for (const r of rows) {
    const watts = Math.max(0, Math.round(r.kw * 1000));
    const dowMon0 = (r.ts.getUTCDay() + 6) % 7; // Mon=0
    const slot = r.ts.getUTCHours() * 4 + Math.floor(r.ts.getUTCMinutes() / 15);
    const idx = dowMon0 * 96 + slot;
    buckets[idx].push(watts);
  }

  const slots = buckets.map((xs) => {
    const mu = mean(xs);
    const s = std(xs, mu);
    // manter algumas amostras para bootstrap (limitar tamanho para JSON)
    const samples = xs.length > 160 ? xs.slice(0, 160) : xs;
    return { samplesWatts: samples, meanWatts: Math.round(mu), stdWatts: Number(s.toFixed(1)) };
  });

  return {
    version: 1,
    trainedAt: new Date().toISOString(),
    meterId,
    slots,
    // alguma inércia para manter continuidade realista
    phi: 0.55
  };
}

function randn() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function generateWatts15mFromModel(model: ConsumptionSlotModel, ts: Date, lastWatts: number) {
  const dowMon0 = (ts.getUTCDay() + 6) % 7;
  const slot = ts.getUTCHours() * 4 + Math.floor(ts.getUTCMinutes() / 15);
  const idx = dowMon0 * 96 + slot;
  const slotInfo = model.slots[idx];

  const mu = Number(slotInfo?.meanWatts ?? 350);
  const sigma = Math.max(10, Number(slotInfo?.stdWatts ?? 60));

  // Bootstrap quando houver amostras suficientes, senão gaussiano.
  const samples = slotInfo?.samplesWatts ?? [];
  const base = samples.length ? samples[Math.floor(Math.random() * samples.length)] : mu + randn() * sigma;

  const smooth = mu + model.phi * (lastWatts - mu) + (1 - model.phi) * (base - mu) + randn() * (sigma * 0.15);
  return Math.max(0, Math.round(smooth));
}
