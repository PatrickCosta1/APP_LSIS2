import { getCollections, initDb } from './db';

export type TariffComparison = {
  consumptionKwhYear: number;
  currentCostYearEur: number;
  bestCostYearEur: number;
  savingsYearEur: number;
  top: Array<{ comercializador: string; nomeProposta: string; costYearEur: number; savingsYearEur: number }>;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

async function estimateConsumptionKwhYear(customerId: string) {
  const db = await initDb();
  const cols = getCollections(db);

  const days = Math.max(7, Math.min(90, Number(process.env.KYNEX_CONSUMPTION_LOOKBACK_DAYS ?? 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // customer_telemetry_15m tem intervalos de 15 minutos: kWh = (watts/1000) * 0.25
  const agg = await cols.customerTelemetry15m
    .aggregate<{ sumWatts: number; points: number }>([
      { $match: { customer_id: customerId, ts: { $gte: since } } },
      { $group: { _id: null, sumWatts: { $sum: '$watts' }, points: { $sum: 1 } } }
    ])
    .toArray();

  const sumWatts = Number(agg[0]?.sumWatts ?? 0);
  const points = Number(agg[0]?.points ?? 0);
  if (points > 0 && sumWatts > 0) {
    const kwh = (sumWatts / 1000) * 0.25;
    const dailyAvg = kwh / days;
    return Math.max(0, dailyAvg * 365);
  }

  const fallback = Number(process.env.KYNEX_CONSUMPTION_FALLBACK_KWH_YEAR ?? 3500);
  return Number.isFinite(fallback) ? fallback : 3500;
}

export async function compareWithErseTariffs(opts: {
  customerId: string;
  contractedPowerKva: number;
  currentPriceKwhEur: number;
  currentFixedDailyFeeEur: number;
}): Promise<TariffComparison> {
  const iva = Number(process.env.KYNEX_IVA ?? 1.23);
  const IVA = Number.isFinite(iva) && iva > 1 ? iva : 1.23;

  const consumptionKwhYear = await estimateConsumptionKwhYear(opts.customerId);

  const currentCostYearEur =
    consumptionKwhYear * opts.currentPriceKwhEur + 365 * opts.currentFixedDailyFeeEur;

  const db = await initDb();
  const cols = getCollections(db);

  const tol = Number(process.env.KYNEX_POWER_TOL_KVA ?? 0.11);
  const minP = Math.max(0, opts.contractedPowerKva - tol);
  const maxP = opts.contractedPowerKva + tol;

  const tariffs = await cols.erseTariffs
    .find({ pot_cont: { $gte: minP, $lte: maxP } }, { projection: { _id: 0, comercializador: 1, nome_proposta: 1, price_kwh_eur: 1, fixed_daily_fee_eur: 1 } })
    .toArray();

  const ranked = tariffs
    .map((t: any) => {
      const cost = consumptionKwhYear * (Number(t.price_kwh_eur) * IVA) + 365 * (Number(t.fixed_daily_fee_eur) * IVA);
      const savings = currentCostYearEur - cost;
      return {
        comercializador: String(t.comercializador ?? 'Desconhecido'),
        nomeProposta: String(t.nome_proposta ?? 'Proposta'),
        costYearEur: round2(cost),
        savingsYearEur: round2(savings)
      };
    })
    .sort((a, b) => b.savingsYearEur - a.savingsYearEur);

  const top = ranked.slice(0, 10);
  const best = top[0];
  const bestCostYearEur = best ? best.costYearEur : round2(currentCostYearEur);
  const savingsYearEur = best ? best.savingsYearEur : 0;

  return {
    consumptionKwhYear: round2(consumptionKwhYear),
    currentCostYearEur: round2(currentCostYearEur),
    bestCostYearEur: round2(bestCostYearEur),
    savingsYearEur: round2(savingsYearEur),
    top
  };
}
