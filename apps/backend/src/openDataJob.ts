import { getCollections, initDb } from './db';
import { fetchLatestRecord, type EredesDataset } from './eredesOpenData';

const DEFAULT_TICK_MS = 6 * 60 * 60 * 1000; // 6h

const NATIONAL_DATASETS: EredesDataset[] = [
  'consumo-total-nacional',
  'energia-produzida-total-nacional',
  'energia-injetada-na-rede-de-distribuicao',
  'previsao-de-consumo'
];

async function refreshDataset(dataset: EredesDataset) {
  const db = await initDb();
  const cols = getCollections(db);

  const record = await fetchLatestRecord(dataset);
  if (!record) return;

  const now = new Date();
  await cols.eredesOpenDataLatest.updateOne(
    { dataset },
    { $set: { dataset, fetched_at: now, record } },
    { upsert: true }
  );
}

async function refreshAll() {
  for (const dataset of NATIONAL_DATASETS) {
    try {
      await refreshDataset(dataset);
    } catch {
      // best-effort
    }
  }
}

export function startEredesOpenDataJob() {
  const tickMs = Math.max(60_000, Number(process.env.KYNEX_EREDES_TICK_MS ?? DEFAULT_TICK_MS));

  // primeiro refresh best-effort
  refreshAll().catch(() => null);

  const interval = setInterval(() => {
    refreshAll().catch(() => null);
  }, tickMs);

  // não impede o processo de terminar
  interval.unref?.();
}
