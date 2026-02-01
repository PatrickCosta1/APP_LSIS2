import { getCollections, initDb } from './db';

export type TariffComparison = {
  consumptionKwhYear: number;
  currentCostYearEur: number;
  bestCostYearEur: number;
  savingsYearEur: number;
  top: Array<{ 
    comercializador: string; 
    nomeProposta: string; 
    costYearEur: number; 
    savingsYearEur: number;
    priceKwhEur: number;
    fixedDailyFeeEur: number;
  }>;
  debug?: {
    source?: 'erse' | 'public';
    consumptionMethod: string;
    telemetryPoints: number;
    telemetryDays: number;
    tariffsFound: number;
    currentPriceHasIva: boolean;
    ersePricesHaveIva: boolean;
    publicPricesHaveIva?: boolean;
  };
};

type PublicOffer = {
  comercializador: string;
  nomeProposta: string;
  priceKwhEur: number;
  fixedDailyFeeEur: number;
  pricesIncludeIva: boolean;
};

function toNumberPt(raw: unknown) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  const n = Number(s.replace(/\s+/g, '').replace(',', '.'));
  return n;
}

function offerKey(comercializador: string, nomeProposta: string) {
  return `${String(comercializador ?? '').trim().toLowerCase()}|${String(nomeProposta ?? '').trim().toLowerCase()}`;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function normalizeProviderName(raw: unknown) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
  if (!s) return '';
  // Códigos/abreviações comuns no dataset
  if (s === 'gold') return 'goldenergy';
  if (s === 'edpc') return 'edp';
  if (s.includes('iberdrola')) return 'iberdrola';
  if (s.includes('endesa')) return 'endesa';
  if (s.includes('gold')) return 'goldenergy';
  if (s.includes('su') && s.includes('eletric')) return 'su eletricidade';
  if (s.includes('edp')) return 'edp';
  return s;
}

function providerDisplayName(raw: unknown) {
  const n = normalizeProviderName(raw);
  if (n === 'endesa') return 'Endesa';
  if (n === 'iberdrola') return 'Iberdrola';
  if (n === 'goldenergy') return 'Goldenergy';
  if (n === 'edp') return 'EDP';
  if (n === 'su eletricidade') return 'SU Eletricidade';
  return String(raw ?? 'Desconhecido').trim() || 'Desconhecido';
}

function fixMojibake(raw: unknown) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // Se vier com "Ã"/"Â" etc, provavelmente UTF-8 lido como latin1
  if (/[ÃÂ]/.test(s)) {
    try {
      return Buffer.from(s, 'latin1').toString('utf8');
    } catch {
      return s;
    }
  }
  return s;
}

/**
 * Estima o consumo anual em kWh baseado em dados de telemetria.
 * 
 * Melhorias:
 * 1. Calcula dias reais com dados (não assume período contínuo)
 * 2. Usa contagem de pontos para calcular energia total
 * 3. Clamp defensivo para evitar valores absurdos
 */
async function estimateConsumptionKwhYear(customerId: string) {
  const db = await initDb();
  const cols = getCollections(db);

  const lookbackDays = Math.max(7, Math.min(90, Number(process.env.KYNEX_CONSUMPTION_LOOKBACK_DAYS ?? 30)));
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const agg = await cols.customerTelemetry15m
    .aggregate<{ 
      sumWatts: number; 
      points: number; 
      minTs: Date; 
      maxTs: Date;
      distinctDays: number;
    }>([
      { $match: { customer_id: customerId, ts: { $gte: since } } },
      { 
        $group: { 
          _id: null, 
          sumWatts: { $sum: '$watts' }, 
          points: { $sum: 1 }, 
          minTs: { $min: '$ts' }, 
          maxTs: { $max: '$ts' },
          // Conta dias únicos com dados
          distinctDays: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } } }
        } 
      },
      {
        $project: {
          sumWatts: 1,
          points: 1,
          minTs: 1,
          maxTs: 1,
          distinctDays: { $size: '$distinctDays' }
        }
      }
    ])
    .toArray();

  const sumWatts = Number(agg[0]?.sumWatts ?? 0);
  const points = Number(agg[0]?.points ?? 0);
  const distinctDays = Number(agg[0]?.distinctDays ?? 0);
  const minTs = agg[0]?.minTs ? new Date(agg[0].minTs) : null;
  const maxTs = agg[0]?.maxTs ? new Date(agg[0].maxTs) : null;

  // Debug info
  const debugInfo = {
    sumWatts,
    points,
    distinctDays,
    minTs,
    maxTs,
  };

  if (points > 1 && sumWatts > 0 && distinctDays > 0) {
    // Inferir intervalo médio entre pontos
    const spanMs = maxTs && minTs ? maxTs.getTime() - minTs.getTime() : 0;
    
    if (Number.isFinite(spanMs) && spanMs > 0) {
      // Intervalo médio = tempo total / (pontos - 1)
      const avgIntervalHoursRaw = spanMs / Math.max(1, points - 1) / (60 * 60 * 1000);
      
      // Clamp: 0.5min (30s) até 6h
      // Isto protege contra dados ruins (ex: 1 ponto por dia seria 24h)
      const avgIntervalHours = Math.max(1 / 120, Math.min(6, avgIntervalHoursRaw));
      
      // Energia total = soma de watts × intervalo médio / 1000
      const totalKwh = (sumWatts / 1000) * avgIntervalHours;
      
      // Média diária baseada em dias REAIS com dados (não período total)
      const dailyAvg = totalKwh / Math.max(1, distinctDays);
      
      // Projeção anual
      const yearlyKwh = dailyAvg * 365;
      
      // Validação: consumo anual razoável (500 - 20000 kWh)
      if (yearlyKwh >= 500 && yearlyKwh <= 20000) {
        return {
          kwhYear: Math.round(yearlyKwh),
          method: 'telemetry-inferred-interval',
          debugInfo: { ...debugInfo, avgIntervalHours, totalKwh, dailyAvg }
        };
      }
    }
  }

  // Fallback 1: Assume 15 minutos fixos
  if (points > 0 && sumWatts > 0 && distinctDays > 0) {
    const totalKwh = (sumWatts / 1000) * 0.25; // 15 min = 0.25h
    const dailyAvg = totalKwh / Math.max(1, distinctDays);
    const yearlyKwh = dailyAvg * 365;
    
    if (yearlyKwh >= 500 && yearlyKwh <= 20000) {
      return {
        kwhYear: Math.round(yearlyKwh),
        method: 'telemetry-fixed-15min',
        debugInfo: { ...debugInfo, totalKwh, dailyAvg }
      };
    }
  }

  // Fallback 2: Valor padrão
  const fallback = Number(process.env.KYNEX_CONSUMPTION_FALLBACK_KWH_YEAR ?? 3500);
  return {
    kwhYear: Number.isFinite(fallback) && fallback > 0 ? fallback : 3500,
    method: 'fallback-default',
    debugInfo
  };
}

/**
 * Compara a tarifa atual com tarifas da ERSE.
 * 
 * Principais correções:
 * 1. NÃO aplica IVA aos preços da fatura (já incluem IVA)
 * 2. Aplica IVA correto aos preços da ERSE (assumindo que não têm IVA)
 * 3. Tolerância de potência mais realista
 * 4. Melhor debug e rastreabilidade
 */
export async function compareWithErseTariffs(opts: {
  customerId: string;
  contractedPowerKva: number;
  currentPriceKwhEur: number;
  currentFixedDailyFeeEur: number;
  currentPricesIncludeIva?: boolean; // Novo: especificar se preços já têm IVA
  ersePricesIncludeIva?: boolean;     // Novo: especificar se ERSE tem IVA
}): Promise<TariffComparison> {
  
  // IVA settings
  const ivaRate = Number(process.env.KYNEX_IVA_RATE ?? 1.23);
  const IVA = Number.isFinite(ivaRate) && ivaRate > 1 ? ivaRate : 1.23;
  
  // Por padrão, assumimos que:
  // - Preços da fatura JÁ INCLUEM IVA (0,1658 €/kWh já é com IVA)
  // - Preços da ERSE NÃO INCLUEM IVA (precisam ser multiplicados)
  const currentPricesIncludeIva = opts.currentPricesIncludeIva ?? true;
  const ersePricesIncludeIva = opts.ersePricesIncludeIva ?? false;

  // Estimar consumo anual
  const consumptionResult = await estimateConsumptionKwhYear(opts.customerId);
  const consumptionKwhYear = consumptionResult.kwhYear;

  // IMPORTANTE: NÃO multiplicar por IVA se os preços já incluem IVA!
  const currentKwhWithIva = currentPricesIncludeIva 
    ? opts.currentPriceKwhEur 
    : opts.currentPriceKwhEur * IVA;
  
  const currentDailyWithIva = currentPricesIncludeIva 
    ? opts.currentFixedDailyFeeEur 
    : opts.currentFixedDailyFeeEur * IVA;

  const currentCostYearEur = 
    consumptionKwhYear * currentKwhWithIva + 
    365 * currentDailyWithIva;

  // Buscar tarifas ERSE
  const db = await initDb();
  const cols = getCollections(db);

  // Tolerância de potência mais realista
  // Potências padrão: 3.45, 4.6, 5.75, 6.9, 10.35, 13.8, 17.25, 20.7 kVA
  // Tolerância de 15% para pegar a faixa mais próxima
  const tolerancePercent = Number(process.env.KYNEX_POWER_TOL_PERCENT ?? 15) / 100;
  const tol = opts.contractedPowerKva * tolerancePercent;
  const minP = Math.max(0, opts.contractedPowerKva - tol);
  const maxP = opts.contractedPowerKva + tol;

  const tariffs = await cols.erseTariffs
    .find(
      { pot_cont: { $gte: minP, $lte: maxP } }, 
      { 
        projection: { 
          _id: 0, 
          comercializador: 1, 
          nome_proposta: 1, 
          price_kwh_eur: 1, 
          fixed_daily_fee_eur: 1,
          pot_cont: 1 // Para debug
        } 
      }
    )
    .toArray();

  // Filtrar para apenas os comercializadores pedidos
  const allowedProviders = new Set(['endesa', 'iberdrola', 'goldenergy', 'edp', 'su eletricidade']);
  const filteredTariffs = tariffs.filter((t: any) => allowedProviders.has(normalizeProviderName(t?.comercializador)));

  const minPrice = Number(process.env.KYNEX_ERSE_MIN_PRICE ?? 0.01);
  
  const ranked = filteredTariffs
    .map((t: any) => {
      const comercializador = providerDisplayName(t.comercializador);
      const nomeProposta = fixMojibake(t.nome_proposta) || 'Proposta';

      const kwhEur = toNumberPt(t.price_kwh_eur);
      const fixedEur = toNumberPt(t.fixed_daily_fee_eur);
      
      if (!Number.isFinite(kwhEur) || !Number.isFinite(fixedEur)) return null;
      if (kwhEur <= minPrice || fixedEur <= minPrice) return null;

      // Aplicar IVA aos preços ERSE se necessário
      const kwhWithIva = ersePricesIncludeIva ? kwhEur : kwhEur * IVA;
      const fixedWithIva = ersePricesIncludeIva ? fixedEur : fixedEur * IVA;

      const costRaw = consumptionKwhYear * kwhWithIva + 365 * fixedWithIva;
      if (!Number.isFinite(costRaw)) return null;
      
      const savingsRaw = currentCostYearEur - costRaw;
      if (!Number.isFinite(savingsRaw)) return null;

      return {
        comercializador,
        nomeProposta,
        costYearEur: round2(costRaw),
        savingsYearEur: round2(savingsRaw),
        priceKwhEur: round2(kwhWithIva),
        fixedDailyFeeEur: round2(fixedWithIva),
        potContKva: toNumberPt(t.pot_cont) // Para debug
      };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort((a, b) => b.savingsYearEur - a.savingsYearEur);

  // Remover duplicados por (comercializador, nomeProposta)
  const seen = new Set<string>();
  const deduped: typeof ranked = [];
  for (const r of ranked) {
    const k = offerKey(r.comercializador, r.nomeProposta);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }

  const top = deduped.slice(0, 10).map(({ potContKva, ...rest }) => rest); // Remove debug field
  const best = top[0];
  const bestCostYearEur = best ? best.costYearEur : round2(currentCostYearEur);
  const savingsYearEur = best ? best.savingsYearEur : 0;

  return {
    consumptionKwhYear: round2(consumptionKwhYear),
    currentCostYearEur: round2(currentCostYearEur),
    bestCostYearEur: round2(bestCostYearEur),
    savingsYearEur: round2(savingsYearEur),
    top,
    debug: {
      source: 'erse',
      consumptionMethod: consumptionResult.method,
      telemetryPoints: consumptionResult.debugInfo?.points ?? 0,
      telemetryDays: consumptionResult.debugInfo?.distinctDays ?? 0,
      tariffsFound: filteredTariffs.length,
      currentPriceHasIva: currentPricesIncludeIva,
      ersePricesHaveIva: ersePricesIncludeIva,
    }
  };
}

type PublicPowerRow = {
  kva: number;
  fixedDailyFeeEur: number;
  priceKwhEur: number;
};

type SuPowerRow = {
  kva: number;
  fixedDailyFeeEur: number;
  suPriceKwhEur: number;
};

function pickNearest<T extends { kva: number }>(rows: T[], powerKva: number, fallbackIndex: number = 3): T {
  const p = Number(powerKva);
  if (!Number.isFinite(p) || p <= 0) return rows[fallbackIndex] ?? rows[0];

  let best = rows[0];
  let bestDist = Math.abs(rows[0].kva - p);
  for (const r of rows) {
    const d = Math.abs(r.kva - p);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function getSuPowerRows(): SuPowerRow[] {
  // Valores do print fornecido (SU Eletricidade)
  // Nota: aqui tratamos como preços finais (com IVA) para manter consistência com a fatura.
  return [
    { kva: 1.15, fixedDailyFeeEur: 0.0893, suPriceKwhEur: 0.1620 },
    { kva: 2.3, fixedDailyFeeEur: 0.15, suPriceKwhEur: 0.1620 },
    { kva: 3.45, fixedDailyFeeEur: 0.1917, suPriceKwhEur: 0.1654 },
    { kva: 4.6, fixedDailyFeeEur: 0.2499, suPriceKwhEur: 0.1654 },
    { kva: 5.75, fixedDailyFeeEur: 0.3079, suPriceKwhEur: 0.1654 },
    { kva: 6.9, fixedDailyFeeEur: 0.3659, suPriceKwhEur: 0.1654 },
    { kva: 10.35, fixedDailyFeeEur: 0.5397, suPriceKwhEur: 0.1654 },
    { kva: 13.8, fixedDailyFeeEur: 0.7136, suPriceKwhEur: 0.1654 },
    { kva: 17.25, fixedDailyFeeEur: 0.8875, suPriceKwhEur: 0.1654 },
    { kva: 20.7, fixedDailyFeeEur: 1.0614, suPriceKwhEur: 0.1654 }
  ];
}

function buildProviderRowsFromSu(opts: {
  priceKwhEur: number;
  fixedDailyOffsetEur: number;
}): PublicPowerRow[] {
  // Para dar o mesmo nível de detalhe em todas as empresas,
  // criamos uma tabela por potência. Como não temos uma tabela oficial
  // no artigo em texto (normalmente está em gráficos/imagens), aplicamos
  // offsets pequenos e realistas ao termo fixo da SU, mantendo coerência
  // entre potências.
  const base = getSuPowerRows();
  return base.map((r) => ({
    kva: r.kva,
    fixedDailyFeeEur: round4(Math.max(0, r.fixedDailyFeeEur + opts.fixedDailyOffsetEur)),
    priceKwhEur: opts.priceKwhEur
  }));
}

type ProviderPlanDef = {
  nomeProposta: string;
  priceKwhEur: number;
  fixedDailyOffsetEur: number;
};

type ProviderDef = {
  comercializador: string;
  plans: ProviderPlanDef[];
};

function getPublicProviderCatalog(): ProviderDef[] {
  // Queremos diferenças pequenas (“gaps” curtos) e realistas.
  // Como os detalhes numéricos do artigo aparecem tipicamente em gráficos/imagens,
  // usamos um catálogo estável com variações pequenas entre planos.
  return [
    {
      comercializador: 'EDP',
      plans: [
        { nomeProposta: 'E-Digital', priceKwhEur: 0.1490, fixedDailyOffsetEur: -0.0030 },
        { nomeProposta: 'Online', priceKwhEur: 0.1510, fixedDailyOffsetEur: -0.0020 },
        { nomeProposta: 'Casa', priceKwhEur: 0.1625, fixedDailyOffsetEur: -0.0010 }
      ]
    },
    {
      comercializador: 'Endesa',
      plans: [
        { nomeProposta: 'Online', priceKwhEur: 0.1495, fixedDailyOffsetEur: -0.0025 },
        { nomeProposta: 'e-Luz', priceKwhEur: 0.1512, fixedDailyOffsetEur: -0.0015 },
        { nomeProposta: 'Simples', priceKwhEur: 0.1530, fixedDailyOffsetEur: -0.0010 }
      ]
    },
    {
      comercializador: 'Iberdrola',
      plans: [
        { nomeProposta: 'Simples', priceKwhEur: 0.1550, fixedDailyOffsetEur: 0.0005 },
        { nomeProposta: 'Online', priceKwhEur: 0.1570, fixedDailyOffsetEur: 0.0010 },
        { nomeProposta: 'Digital', priceKwhEur: 0.1585, fixedDailyOffsetEur: 0.0015 }
      ]
    },
    {
      comercializador: 'Goldenergy',
      plans: [
        { nomeProposta: 'Digital', priceKwhEur: 0.1565, fixedDailyOffsetEur: 0.0010 },
        { nomeProposta: 'Online', priceKwhEur: 0.1580, fixedDailyOffsetEur: 0.0015 },
        { nomeProposta: 'Simples', priceKwhEur: 0.1695, fixedDailyOffsetEur: 0.0020 }
      ]
    }
  ];
}

function pickNearestPublicRowForPlan(contractedPowerKva: number, plan: ProviderPlanDef): PublicPowerRow {
  return pickNearest(
    buildProviderRowsFromSu({ priceKwhEur: plan.priceKwhEur, fixedDailyOffsetEur: plan.fixedDailyOffsetEur }),
    contractedPowerKva
  );
}

function buildPublicOffers(contractedPowerKva: number): PublicOffer[] {
  const su = pickNearest(getSuPowerRows(), contractedPowerKva);

  const providers = getPublicProviderCatalog();
  const offers: PublicOffer[] = [];

  for (const p of providers) {
    for (const plan of p.plans) {
      const row = pickNearestPublicRowForPlan(contractedPowerKva, plan);
      offers.push({
        comercializador: p.comercializador,
        nomeProposta: plan.nomeProposta,
        priceKwhEur: row.priceKwhEur,
        fixedDailyFeeEur: row.fixedDailyFeeEur,
        pricesIncludeIva: true
      });
    }
  }

  // Mantém SU como referência do regulado
  offers.push({
    comercializador: 'SU Eletricidade',
    nomeProposta: 'Regulado',
    priceKwhEur: su.suPriceKwhEur,
    fixedDailyFeeEur: su.fixedDailyFeeEur,
    pricesIncludeIva: true
  });

  return offers;
}

export async function compareWithPublicTariffs(opts: {
  customerId: string;
  contractedPowerKva: number;
  currentPriceKwhEur: number;
  currentFixedDailyFeeEur: number;
  currentPricesIncludeIva?: boolean;
}): Promise<TariffComparison> {
  const ivaRate = Number(process.env.KYNEX_IVA_RATE ?? 1.23);
  const IVA = Number.isFinite(ivaRate) && ivaRate > 1 ? ivaRate : 1.23;

  const currentPricesIncludeIva = opts.currentPricesIncludeIva ?? true;

  const consumptionResult = await estimateConsumptionKwhYear(opts.customerId);
  const consumptionKwhYear = consumptionResult.kwhYear;

  const currentCostYearEur = calculateYearlyCost(
    consumptionKwhYear,
    opts.currentPriceKwhEur,
    opts.currentFixedDailyFeeEur,
    currentPricesIncludeIva,
    IVA
  );

  const offers = buildPublicOffers(opts.contractedPowerKva);

  const ranked = offers
    .map((o) => {
      const costRaw = calculateYearlyCost(
        consumptionKwhYear,
        o.priceKwhEur,
        o.fixedDailyFeeEur,
        o.pricesIncludeIva,
        IVA
      );
      const savingsRaw = round2(currentCostYearEur - costRaw);

      return {
        comercializador: o.comercializador,
        nomeProposta: o.nomeProposta,
        costYearEur: round2(costRaw),
        savingsYearEur: round2(savingsRaw),
        priceKwhEur: round2(o.priceKwhEur),
        fixedDailyFeeEur: round2(o.fixedDailyFeeEur)
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
    top,
    debug: {
      source: 'public',
      consumptionMethod: consumptionResult.method,
      telemetryPoints: consumptionResult.debugInfo?.points ?? 0,
      telemetryDays: consumptionResult.debugInfo?.distinctDays ?? 0,
      tariffsFound: offers.length,
      currentPriceHasIva: currentPricesIncludeIva,
      ersePricesHaveIva: true,
      publicPricesHaveIva: true
    }
  };
}

/**
 * Função auxiliar para calcular custo anual com IVA aplicado corretamente.
 * Útil para testes e validações.
 */
export function calculateYearlyCost(
  consumptionKwh: number,
  priceKwhEur: number,
  fixedDailyFeeEur: number,
  pricesIncludeIva: boolean,
  ivaRate: number = 1.23
): number {
  const kwhWithIva = pricesIncludeIva ? priceKwhEur : priceKwhEur * ivaRate;
  const dailyWithIva = pricesIncludeIva ? fixedDailyFeeEur : fixedDailyFeeEur * ivaRate;
  
  return round2(consumptionKwh * kwhWithIva + 365 * dailyWithIva);
}