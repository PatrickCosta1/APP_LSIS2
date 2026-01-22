import type { Collections } from './db';
import { buildNationalContext, fetchLatestRecord, type NationalOpenDataContext } from './eredesOpenData';

export async function getEredesNationalContext(c: Collections, maxAgeMs = 6 * 60 * 60 * 1000): Promise<NationalOpenDataContext> {
  const now = Date.now();

  async function getOrRefresh(
    dataset: 'consumo-total-nacional' | 'energia-produzida-total-nacional' | 'energia-injetada-na-rede-de-distribuicao' | 'previsao-de-consumo'
  ) {
    const doc = await c.eredesOpenDataLatest.findOne({ dataset }, { projection: { _id: 0, dataset: 1, fetched_at: 1, record: 1 } });
    const ageOk = doc?.fetched_at ? now - new Date(doc.fetched_at).getTime() <= maxAgeMs : false;
    if (doc?.record && ageOk) return doc.record;

    try {
      const record = await fetchLatestRecord(dataset);
      if (record) {
        await c.eredesOpenDataLatest.updateOne({ dataset }, { $set: { dataset, fetched_at: new Date(), record } }, { upsert: true });
        return record;
      }
    } catch {
      // ignore
    }

    return doc?.record ?? null;
  }

  const [cons, prod, inj, prev] = await Promise.all([
    getOrRefresh('consumo-total-nacional'),
    getOrRefresh('energia-produzida-total-nacional'),
    getOrRefresh('energia-injetada-na-rede-de-distribuicao'),
    getOrRefresh('previsao-de-consumo')
  ]);

  return buildNationalContext({
    consumoTotalNacional: cons,
    energiaProduzidaTotalNacional: prod,
    energiaInjetadaRedeDistribuicao: inj,
    previsaoDeConsumo: prev
  });
}
