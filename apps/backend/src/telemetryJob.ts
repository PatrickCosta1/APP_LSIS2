import { getCollections, initDb } from './db';

type CustomerRow = {
  id: string;
  segment: string;
  contracted_power_kva: number;
  home_area_m2: number;
  household_size: number;
  has_solar: boolean;
  ev_count: number;
  price_eur_per_kwh: number;
};

const SAMPLE_INTERVAL_MINUTES = 15;
const SAMPLE_INTERVAL_HOURS = SAMPLE_INTERVAL_MINUTES / 60;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function randn() {
  // Box–Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function simulateNextWatts(customer: CustomerRow, ts: Date, lastWatts: number) {
  const hour = ts.getUTCHours() + ts.getUTCMinutes() / 60;

  // Base proporcional ao tamanho/ocupação
  const base = 180 + customer.home_area_m2 * 1.6 + customer.household_size * 90;

  // Padrão diário (picos manhã/noite)
  const morning = Math.exp(-Math.pow(hour - 8.2, 2) / (2 * 1.4 * 1.4));
  const evening = Math.exp(-Math.pow(hour - 20.2, 2) / (2 * 1.8 * 1.8));
  const midday = Math.exp(-Math.pow(hour - 13.0, 2) / (2 * 2.2 * 2.2));

  let watts = base * (0.75 + 0.95 * morning + 1.25 * evening + 0.25 * midday);

  // EV (carregamento noturno)
  if (customer.ev_count > 0 && (hour >= 0 && hour <= 6.5)) {
    watts += 950 * clamp(customer.ev_count, 0, 3);
  }

  // Solar (reduz carga líquida no meio do dia)
  if (customer.has_solar && hour >= 10 && hour <= 16) {
    watts -= 260 + 40 * Math.sin((hour - 10) * Math.PI / 6);
  }

  // Inércia/ruído
  watts = 0.72 * watts + 0.28 * lastWatts + randn() * 55;

  const maxWatts = Math.max(1200, customer.contracted_power_kva * 1000 * 0.92);
  watts = clamp(watts, 80, maxWatts);

  return Math.round(watts);
}

function simulateTempC(ts: Date) {
  // Estação + ciclo diário (simplificado)
  const dayOfYear = Math.floor(
    (Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth(), ts.getUTCDate()) - Date.UTC(ts.getUTCFullYear(), 0, 0)) /
      (24 * 60 * 60 * 1000)
  );
  const season = 12 + 6 * Math.sin((2 * Math.PI * (dayOfYear - 30)) / 365);
  const hour = ts.getUTCHours() + ts.getUTCMinutes() / 60;
  const daily = 3 * Math.sin((2 * Math.PI * (hour - 14)) / 24);
  return Number((season + daily + randn() * 0.6).toFixed(2));
}

export async function seedCustomerTelemetry(customer: CustomerRow, days = 1) {
  await initDb();
  const c = getCollections();

  const latestRow = await c.customerTelemetry15m
    .find({ customer_id: customer.id }, { projection: { _id: 1 } })
    .limit(1)
    .toArray();
  if (latestRow.length) return;

  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // alinhar aos 15 minutos
  const aligned = new Date(start);
  aligned.setUTCMinutes(Math.floor(aligned.getUTCMinutes() / 15) * 15, 0, 0);

  let ts = aligned;
  let lastWatts = 420;

  const docs = [] as Array<{
    customer_id: string;
    ts: Date;
    watts: number;
    euros: number;
    temp_c: number;
    is_estimated: boolean;
  }>;

  for (let i = 0; i < days * 96; i += 1) {
    lastWatts = simulateNextWatts(customer, ts, lastWatts);
    const kwh = (lastWatts / 1000) * SAMPLE_INTERVAL_HOURS;
    const euros = kwh * (customer.price_eur_per_kwh ?? 0.2);
    docs.push({
      customer_id: customer.id,
      ts,
      watts: lastWatts,
      euros: Number(euros.toFixed(6)),
      temp_c: simulateTempC(ts),
      is_estimated: false
    });
    ts = new Date(ts.getTime() + SAMPLE_INTERVAL_MINUTES * 60 * 1000);
  }

  if (docs.length) await c.customerTelemetry15m.insertMany(docs);
}

export function startTelemetryJob() {
  const tickMs = Number.parseInt(process.env.KYNEX_SIM_TICK_MS ?? '10000', 10);
  if (!Number.isFinite(tickMs) || tickMs < 500) {
    // eslint-disable-next-line no-console
    console.warn('KYNEX_SIM_TICK_MS inválido; a usar 10000ms');
  }

  const effectiveTickMs = Number.isFinite(tickMs) && tickMs >= 500 ? tickMs : 10000;

  let interval: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight = false;

  const normalizeCustomer = (doc: any): CustomerRow => {
    const id = String(doc?.id ?? '');
    return {
      id,
      segment: String(doc?.segment ?? 'Residencial'),
      contracted_power_kva: Number(doc?.contracted_power_kva ?? 6.9),
      home_area_m2: Number(doc?.home_area_m2 ?? 90),
      household_size: Number(doc?.household_size ?? 2),
      has_solar: Boolean(doc?.has_solar ?? false),
      ev_count: Number(doc?.ev_count ?? 0),
      price_eur_per_kwh: Number(doc?.price_eur_per_kwh ?? 0.2)
    };
  };

  const start = async () => {
    try {
      await initDb();
      const c = getCollections();

      interval = setInterval(() => {
        if (stopped || inFlight) return;
        inFlight = true;

        void (async () => {
          try {
            const customerDocs = await c.customers
              .find(
                {},
                {
                  projection: {
                    _id: 0,
                    id: 1,
                    segment: 1,
                    contracted_power_kva: 1,
                    home_area_m2: 1,
                    household_size: 1,
                    has_solar: 1,
                    ev_count: 1,
                    price_eur_per_kwh: 1
                  }
                }
              )
              .toArray();

            const customers = customerDocs.map(normalizeCustomer).filter((x) => x.id.length > 0);
            if (!customers.length) return;

            const ids = customers.map((x) => x.id);
            const latestRows = await c.customerTelemetry15m
              .aggregate([
                { $match: { customer_id: { $in: ids } } },
                { $sort: { customer_id: 1, ts: -1 } },
                { $group: { _id: '$customer_id', ts: { $first: '$ts' }, watts: { $first: '$watts' } } }
              ])
              .toArray();

            const latestByCustomer = new Map<string, { ts: Date; watts: number }>();
            for (const row of latestRows as any[]) {
              const id = String(row?._id ?? '');
              const ts = row?.ts instanceof Date ? row.ts : row?.ts ? new Date(row.ts) : null;
              const watts = Number(row?.watts);
              if (id.length > 0 && ts && Number.isFinite(watts)) latestByCustomer.set(id, { ts, watts });
            }

            const nowAligned = new Date();
            nowAligned.setUTCMinutes(Math.floor(nowAligned.getUTCMinutes() / 15) * 15, 0, 0);

            const docs = [] as Array<{
              customer_id: string;
              ts: Date;
              watts: number;
              euros: number;
              temp_c: number;
              is_estimated: boolean;
            }>;

            for (const customer of customers) {
              const latest = latestByCustomer.get(customer.id);
              const nextTs = latest ? new Date(latest.ts.getTime() + SAMPLE_INTERVAL_MINUTES * 60 * 1000) : nowAligned;
              const lastWatts = latest ? latest.watts : 420;

              const nextWatts = simulateNextWatts(customer, nextTs, lastWatts);
              const kwh = (nextWatts / 1000) * SAMPLE_INTERVAL_HOURS;
              const euros = kwh * (customer.price_eur_per_kwh ?? 0.2);
              const tempC = simulateTempC(nextTs);

              docs.push({
                customer_id: customer.id,
                ts: nextTs,
                watts: nextWatts,
                euros: Number(euros.toFixed(6)),
                temp_c: tempC,
                is_estimated: true
              });
            }

            if (docs.length) await c.customerTelemetry15m.insertMany(docs);
          } catch {
            // não derruba o server
          } finally {
            inFlight = false;
          }
        })();
      }, effectiveTickMs);

      // eslint-disable-next-line no-console
      console.log(`Telemetria sintética contínua ativa (tick=${effectiveTickMs}ms, step=${SAMPLE_INTERVAL_MINUTES}min)`);
    } catch {
      // não derruba o server
    }
  };

  void start();

  return () => {
    stopped = true;
    if (interval) clearInterval(interval);
  };
}
