import { getCollections, initDb } from './db';
import { refreshErseTariffsFromZipUrl } from './erseTariffs';

const DEFAULT_TICK_MS = 24 * 60 * 60 * 1000; // 24h

export function startErseTariffsJob() {
  const tickMs = Math.max(60_000, Number(process.env.KYNEX_ERSE_TICK_MS ?? DEFAULT_TICK_MS));

  const url = String(process.env.KYNEX_ERSE_TARIFF_ZIP_URL ?? '').trim();
  if (!url) {
    // Sem URL configurado: não falha o backend, mas regista e não executa.
    // eslint-disable-next-line no-console
    console.warn('KYNEX_ERSE_TARIFF_ZIP_URL não definido; job ERSE não será executado.');
    return;
  }

  async function tick() {
    const result = await refreshErseTariffsFromZipUrl(url);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(`ERSE refresh falhou: ${result.error ?? 'erro desconhecido'}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`ERSE atualizado: ${result.rowCount} linhas (${result.importedAt.toISOString()})`);
    }

    // sanity: se houver 0 linhas, mantém histórico no imports e não apaga nada
    const db = await initDb();
    const cols = getCollections(db);
    await cols.erseTariffImports.createIndex({ fetched_at: -1 }).catch(() => null);
  }

  // primeiro refresh best-effort
  tick().catch(() => null);

  const interval = setInterval(() => {
    tick().catch(() => null);
  }, tickMs);

  interval.unref?.();
}
