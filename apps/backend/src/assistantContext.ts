import type { Collections, CustomerDoc } from './db';
import { inferAppliancesFromAggregate } from './nilmInfer';
import { getEredesNationalContext } from './openDataContext';

export type AssistantEnergyWindow = { kwh: number; costEur: number };

export type AssistantBaseContext = {
  customer: {
    id: string;
    name: string | null;
    tariff: string | null;
    contractedPowerKva: number | null;
    utility?: string | null;
    priceEurPerKwh?: number | null;
    fixedDailyFeeEur?: number | null;
  };
  telemetry: {
    lastUpdated: string | null;
    last24h?: AssistantEnergyWindow | null;
    last7d?: AssistantEnergyWindow | null;
    monthToDate?: AssistantEnergyWindow | null;
  };
  appliances?: {
    top30d?: Array<{ applianceId: number; name: string; category: string | null; costEur: number; energyKwh: number }>;
  };
  grid?: unknown;
};

export function buildAssistantEnvelope(opts: {
  base: AssistantBaseContext;
  extra?: unknown;
}) {
  return {
    ...opts.base,
    extra: opts.extra ?? null
  };
}

async function getLatestTelemetryTs(c: Collections, customerId: string): Promise<Date | null> {
  const row = await c.customerTelemetry15m
    .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1 } })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();
  const ts = row[0]?.ts;
  return ts ? new Date(ts) : null;
}

async function getEnergyWindow(c: Collections, customerId: string, end: Date, hours: number): Promise<AssistantEnergyWindow> {
  const since = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const rows = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: since, $lte: end } } },
      { $group: { _id: null, sumWatts: { $sum: '$watts' }, sumEur: { $sum: '$euros' } } }
    ])
    .toArray();
  const sumWatts = Number((rows as any[])[0]?.sumWatts ?? 0);
  const sumEur = Number((rows as any[])[0]?.sumEur ?? 0);
  const kwh = (sumWatts * 0.25) / 1000;
  return { kwh: Number(kwh.toFixed(2)), costEur: Number(sumEur.toFixed(2)) };
}

async function getMonthToDateWindow(c: Collections, customerId: string, end: Date): Promise<AssistantEnergyWindow> {
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1, 0, 0, 0));
  const rows = await c.customerTelemetry15m
    .aggregate([
      { $match: { customer_id: customerId, ts: { $gte: start, $lte: end } } },
      { $group: { _id: null, sumWatts: { $sum: '$watts' }, sumEur: { $sum: '$euros' } } }
    ])
    .toArray();
  const sumWatts = Number((rows as any[])[0]?.sumWatts ?? 0);
  const sumEur = Number((rows as any[])[0]?.sumEur ?? 0);
  const kwh = (sumWatts * 0.25) / 1000;
  return { kwh: Number(kwh.toFixed(2)), costEur: Number(sumEur.toFixed(2)) };
}

async function getTopAppliances30d(c: Collections, customerId: string, end: Date, limit = 5) {
  const since = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const customer = await c.customers.findOne(
    { id: customerId },
    { projection: { _id: 0, id: 1, price_eur_per_kwh: 1 } }
  );
  const price = typeof (customer as any)?.price_eur_per_kwh === 'number' && Number.isFinite((customer as any).price_eur_per_kwh)
    ? Number((customer as any).price_eur_per_kwh)
    : 0.2;

  const points = await c.customerTelemetry15m
    .find(
      { customer_id: customerId, ts: { $gte: since, $lte: end } },
      { projection: { _id: 0, ts: 1, watts: 1 } }
    )
    .sort({ ts: 1 })
    .toArray();

  const inferred = inferAppliancesFromAggregate({
    points: (points as any[]).map((p) => ({ ts: new Date(p.ts), watts: Number(p.watts ?? 0) })),
    priceEurPerKwh: price,
    maxAppliances: Math.max(1, Math.min(10, Math.floor(limit)))
  });

  return inferred.appliances
    .slice(0, Math.max(1, Math.min(10, Math.floor(limit))))
    .map((a) => ({
      applianceId: a.id,
      name: a.name,
      category: a.category,
      costEur: a.costEur,
      energyKwh: a.energyKwh
    }));
}

export async function buildAssistantBaseContext(
  c: Collections,
  customer: CustomerDoc,
  opts?: {
    end?: Date | null;
    includeGrid?: boolean;
    includeEnergyWindows?: boolean;
    includeTopAppliances30d?: boolean;
    topAppliancesLimit?: number;
  }
): Promise<AssistantBaseContext> {
  const end = opts?.end ?? (await getLatestTelemetryTs(c, customer.id));

  const [grid, last24h, last7d, mtd, top30] = await Promise.all([
    opts?.includeGrid ? getEredesNationalContext(c).catch(() => null) : Promise.resolve(undefined),
    opts?.includeEnergyWindows && end ? getEnergyWindow(c, customer.id, end, 24).catch(() => null) : Promise.resolve(undefined),
    opts?.includeEnergyWindows && end ? getEnergyWindow(c, customer.id, end, 24 * 7).catch(() => null) : Promise.resolve(undefined),
    opts?.includeEnergyWindows && end ? getMonthToDateWindow(c, customer.id, end).catch(() => null) : Promise.resolve(undefined),
    opts?.includeTopAppliances30d && end
      ? getTopAppliances30d(c, customer.id, end, opts?.topAppliancesLimit ?? 5).catch(() => [])
      : Promise.resolve(undefined)
  ]);

  const base: AssistantBaseContext = {
    customer: {
      id: customer.id,
      name: customer.name ?? null,
      tariff: (customer as any).tariff ?? null,
      contractedPowerKva: (customer as any).contracted_power_kva ?? null,
      utility: (customer as any).utility ?? null,
      priceEurPerKwh: typeof (customer as any).price_eur_per_kwh === 'number' ? (customer as any).price_eur_per_kwh : null,
      fixedDailyFeeEur: typeof (customer as any).fixed_daily_fee_eur === 'number' ? (customer as any).fixed_daily_fee_eur : null
    },
    telemetry: {
      lastUpdated: end ? end.toISOString() : null
    }
  };

  if (typeof grid !== 'undefined') base.grid = grid;
  if (typeof last24h !== 'undefined') base.telemetry.last24h = last24h;
  if (typeof last7d !== 'undefined') base.telemetry.last7d = last7d;
  if (typeof mtd !== 'undefined') base.telemetry.monthToDate = mtd;
  if (typeof top30 !== 'undefined') base.appliances = { top30d: top30 };

  return base;
}
