import { getDb } from './db';

type CustomerRow = {
  id: string;
  segment: string;
  contracted_power_kva: number;
  home_area_m2: number;
  household_size: number;
  has_solar: number;
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

export function seedCustomerTelemetry(customer: CustomerRow, days = 1) {
  const db = getDb();

  const insert = db.prepare(
    'INSERT INTO customer_telemetry_15m (customer_id, ts, watts, euros, temp_c, is_estimated) VALUES (?, ?, ?, ?, ?, 0)'
  );

  const latest = db
    .prepare('SELECT ts FROM customer_telemetry_15m WHERE customer_id = ? ORDER BY ts DESC LIMIT 1')
    .get(customer.id) as { ts: string } | undefined;
  if (latest) return;

  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // alinhar aos 15 minutos
  const aligned = new Date(start);
  aligned.setUTCMinutes(Math.floor(aligned.getUTCMinutes() / 15) * 15, 0, 0);

  let ts = aligned;
  let lastWatts = 420;

  const tx = db.transaction(() => {
    for (let i = 0; i < days * 96; i += 1) {
      lastWatts = simulateNextWatts(customer, ts, lastWatts);
      const kwh = (lastWatts / 1000) * SAMPLE_INTERVAL_HOURS;
      const euros = kwh * (customer.price_eur_per_kwh ?? 0.2);
      insert.run(customer.id, ts.toISOString(), lastWatts, Number(euros.toFixed(6)), simulateTempC(ts));
      ts = new Date(ts.getTime() + SAMPLE_INTERVAL_MINUTES * 60 * 1000);
    }
  });

  tx();
}

export function startTelemetryJob() {
  const db = getDb();

  const tickMs = Number.parseInt(process.env.KYNEX_SIM_TICK_MS ?? '10000', 10);
  if (!Number.isFinite(tickMs) || tickMs < 500) {
    // eslint-disable-next-line no-console
    console.warn('KYNEX_SIM_TICK_MS inválido; a usar 10000ms');
  }

  const effectiveTickMs = Number.isFinite(tickMs) && tickMs >= 500 ? tickMs : 10000;

  const listCustomers = db.prepare(
    'SELECT id, segment, contracted_power_kva, home_area_m2, household_size, has_solar, ev_count, price_eur_per_kwh FROM customers'
  );

  const getLatest = db.prepare(
    'SELECT ts, watts FROM customer_telemetry_15m WHERE customer_id = ? ORDER BY ts DESC LIMIT 1'
  );

  const insert = db.prepare(
    'INSERT INTO customer_telemetry_15m (customer_id, ts, watts, euros, temp_c, is_estimated) VALUES (?, ?, ?, ?, ?, 1)'
  );

  const tx = db.transaction((rows: CustomerRow[]) => {
    for (const customer of rows) {
      const latest = getLatest.get(customer.id) as { ts: string; watts: number } | undefined;
      if (!latest) {
        // Cliente novo: começa sem dados. O primeiro ponto entra no próximo tick.
        const initialTs = new Date();
        initialTs.setUTCMinutes(Math.floor(initialTs.getUTCMinutes() / 15) * 15, 0, 0);
        const initialWatts = simulateNextWatts(customer, initialTs, 420);
        const kwh = (initialWatts / 1000) * SAMPLE_INTERVAL_HOURS;
        const euros = kwh * (customer.price_eur_per_kwh ?? 0.2);
        const tempC = simulateTempC(initialTs);

        insert.run(customer.id, initialTs.toISOString(), initialWatts, Number(euros.toFixed(6)), tempC);
        continue;
      }

      const nextTs = new Date(new Date(latest.ts).getTime() + SAMPLE_INTERVAL_MINUTES * 60 * 1000);
      const nextWatts = simulateNextWatts(customer, nextTs, latest.watts);
      const kwh = (nextWatts / 1000) * SAMPLE_INTERVAL_HOURS;
      const euros = kwh * (customer.price_eur_per_kwh ?? 0.2);
      const tempC = simulateTempC(nextTs);

      insert.run(customer.id, nextTs.toISOString(), nextWatts, Number(euros.toFixed(6)), tempC);
    }
  });

  const interval = setInterval(() => {
    try {
      const customers = listCustomers.all() as CustomerRow[];
      if (!customers.length) return;
      tx(customers);
    } catch {
      // não derruba o server
    }
  }, effectiveTickMs);

  // eslint-disable-next-line no-console
  console.log(`Telemetria sintética contínua ativa (tick=${effectiveTickMs}ms, step=${SAMPLE_INTERVAL_MINUTES}min)`);

  return () => clearInterval(interval);
}
