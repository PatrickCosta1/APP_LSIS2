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

type SimProfile = {
  baseBias: number;
  morningPeak: number;
  eveningPeak: number;
  middayPeak: number;
  weekendMultiplier: number;
  noiseSigma: number;
  inertia: number;
  solarStrength: number;
  evStrength: number;
};

type OngoingEvent = {
  kind: 'cook' | 'laundry' | 'anomaly' | 'idle_spike';
  remainingSteps: number;
  extraWatts: number;
};

const profileCache = new Map<string, SimProfile>();
const eventByCustomer = new Map<string, OngoingEvent>();

type ApplianceSessionState = {
  active: boolean;
  startTs: Date | null;
  energyWh: number;
  confidence: number;
};

const applianceSessionsByCustomer = new Map<string, Map<number, ApplianceSessionState>>();

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

function hash32(s: string) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rand01(seed: number) {
  // xorshift32
  let x = seed >>> 0;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return (x >>> 0) / 0xffffffff;
}

function pickProfile(customer: CustomerRow): SimProfile {
  const cached = profileCache.get(customer.id);
  if (cached) return cached;

  const seed = hash32(customer.id);
  const r = (k: number) => rand01(seed ^ k);

  const segment = String(customer.segment ?? 'Residencial').toLowerCase();
  const hh = clamp(customer.household_size ?? 2, 1, 6);
  const area = clamp(customer.home_area_m2 ?? 90, 40, 220);

  // baseBias: residencial tende a ter mais variação; industrial mais constante.
  const segRes = segment.includes('resi');
  const segSme = segment.includes('sme') || segment.includes('com');
  const segInd = segment.includes('ind');

  const baseBias = 160 + area * 1.4 + hh * 85 + (segInd ? 420 : segSme ? 220 : 0) + (r(1) - 0.5) * 80;
  const morningPeak = (segInd ? 0.15 : segSme ? 0.35 : 0.9) + (r(2) - 0.5) * 0.15;
  const eveningPeak = (segInd ? 0.1 : segSme ? 0.45 : 1.25) + (r(3) - 0.5) * 0.18;
  const middayPeak = (segInd ? 0.25 : segSme ? 0.95 : 0.35) + (r(4) - 0.5) * 0.2;
  const weekendMultiplier = segInd ? 0.92 : segSme ? 0.78 : 1.06 + (r(5) - 0.5) * 0.06;

  const noiseSigma = 40 + (segInd ? 20 : 45) + (r(6) * 20);
  const inertia = clamp(0.7 + (r(7) - 0.5) * 0.1, 0.55, 0.82);
  const solarStrength = customer.has_solar ? 1.0 + (r(8) - 0.5) * 0.25 : 0;
  const evStrength = customer.ev_count > 0 ? 1.0 + (r(9) - 0.5) * 0.2 : 0;

  const prof = { baseBias, morningPeak, eveningPeak, middayPeak, weekendMultiplier, noiseSigma, inertia, solarStrength, evStrength };
  profileCache.set(customer.id, prof);
  return prof;
}

function maybeTriggerEvent(customer: CustomerRow, ts: Date) {
  const id = customer.id;
  const existing = eventByCustomer.get(id);
  if (existing && existing.remainingSteps > 0) return;

  const hour = ts.getUTCHours() + ts.getUTCMinutes() / 60;
  const dow = (ts.getUTCDay() + 6) % 7;
  const isWeekend = dow >= 5;
  const seed = hash32(`${id}:${ts.toISOString().slice(0, 16)}`);
  const u = rand01(seed);

  // Probabilidades pequenas por amostra, mas suficientes para gerar eventos visíveis.
  const pCook = (hour >= 11 && hour <= 14) || (hour >= 18.5 && hour <= 21.5) ? 0.018 : 0.003;
  const pLaundry = isWeekend && hour >= 9 && hour <= 17 ? 0.012 : 0.002;
  const pAnomaly = 0.0015;

  if (u < pAnomaly) {
    eventByCustomer.set(id, { kind: 'anomaly', remainingSteps: 1 + Math.floor(rand01(seed ^ 11) * 3), extraWatts: 900 + rand01(seed ^ 12) * 1400 });
    return;
  }
  if (u < pAnomaly + pLaundry) {
    eventByCustomer.set(id, { kind: 'laundry', remainingSteps: 6 + Math.floor(rand01(seed ^ 13) * 8), extraWatts: 450 + rand01(seed ^ 14) * 650 });
    return;
  }
  if (u < pAnomaly + pLaundry + pCook) {
    eventByCustomer.set(id, { kind: 'cook', remainingSteps: 2 + Math.floor(rand01(seed ^ 15) * 4), extraWatts: 700 + rand01(seed ^ 16) * 900 });
    return;
  }

  // “picos” curtos aleatórios (ex.: ligar chaleira/microondas)
  if (u < pAnomaly + pLaundry + pCook + 0.002) {
    eventByCustomer.set(id, { kind: 'idle_spike', remainingSteps: 1, extraWatts: 300 + rand01(seed ^ 17) * 650 });
  }
}

function simulateNextWatts(customer: CustomerRow, ts: Date, lastWatts: number) {
  const hour = ts.getUTCHours() + ts.getUTCMinutes() / 60;
  const dow = (ts.getUTCDay() + 6) % 7;
  const isWeekend = dow >= 5;

  const prof = pickProfile(customer);
  maybeTriggerEvent(customer, ts);
  const ev = eventByCustomer.get(customer.id);

  // Base proporcional ao tamanho/ocupação + perfil
  const base = prof.baseBias;

  // Padrão diário (picos manhã/noite)
  const morning = Math.exp(-Math.pow(hour - 8.2, 2) / (2 * 1.4 * 1.4));
  const evening = Math.exp(-Math.pow(hour - 20.2, 2) / (2 * 1.8 * 1.8));
  const midday = Math.exp(-Math.pow(hour - 13.0, 2) / (2 * 2.2 * 2.2));

  let watts = base * (0.65 + prof.morningPeak * morning + prof.eveningPeak * evening + prof.middayPeak * midday);

  // Fim de semana (residencial aumenta, SME/industrial tende a baixar)
  if (isWeekend) watts *= prof.weekendMultiplier;

  // EV (carregamento noturno)
  if (customer.ev_count > 0 && (hour >= 0 && hour <= 6.5)) {
    watts += 950 * clamp(customer.ev_count, 0, 3) * prof.evStrength;
  }

  // Solar (reduz carga líquida no meio do dia)
  if (customer.has_solar && hour >= 10 && hour <= 16) {
    // “nuvens” simplificadas: atenua ligeiramente o solar por dia
    const cloud = 0.65 + 0.35 * rand01(hash32(`${customer.id}:${ts.toISOString().slice(0, 10)}`));
    watts -= (260 + 40 * Math.sin((hour - 10) * Math.PI / 6)) * prof.solarStrength * cloud;
  }

  // Eventos (ciclos/picos)
  if (ev && ev.remainingSteps > 0) {
    watts += ev.extraWatts;
    ev.remainingSteps -= 1;
    if (ev.remainingSteps <= 0) eventByCustomer.delete(customer.id);
  }

  // Inércia/ruído
  watts = prof.inertia * watts + (1 - prof.inertia) * lastWatts + randn() * prof.noiseSigma;

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

function applianceWattsProvisional(customer: CustomerRow, ts: Date, tempC: number, ongoingLaundryWatts: number) {
  // IDs alinhados com a seed em db.ts
  const AP_FRIDGE = 1;
  const AP_WASH = 3;
  const AP_LIGHTS = 4;
  const AP_STANDBY = 5;
  const AP_AC = 6;
  const AP_WATER = 7;

  const hour = ts.getUTCHours() + ts.getUTCMinutes() / 60;
  const stepOfDay = ts.getUTCHours() * 4 + Math.floor(ts.getUTCMinutes() / 15);
  const seedBase = hash32(`${customer.id}:${ts.toISOString().slice(0, 10)}`);

  // Stand-by: sempre presente
  const standby = clamp(18 + (customer.household_size ?? 2) * 9 + rand01(seedBase ^ 201) * 12, 10, 95);

  // Luz: manhã cedo e fim de tarde/noite
  const lightsOn = (hour >= 6 && hour <= 7.5) || (hour >= 18 && hour <= 23.3);
  const lights = lightsOn ? clamp(25 + (customer.household_size ?? 2) * 18 + rand01(seedBase ^ 202) * 35, 15, 180) : 0;

  // Frigorífico: ciclo determinístico (compressor liga/desliga)
  const fridgePeriod = 8; // 2h
  const fridgeOnSteps = 2; // 30min
  const fridgeOffset = Math.floor(rand01(seedBase ^ 203) * fridgePeriod);
  const fridgeOn = ((stepOfDay + fridgeOffset) % fridgePeriod) < fridgeOnSteps;
  const fridge = fridgeOn ? clamp(90 + rand01(seedBase ^ 204) * 70, 70, 190) : 0;

  // Água quente: sessões mais prováveis manhã/noite
  const waterWindow = (hour >= 6 && hour <= 9) || (hour >= 19 && hour <= 22.5);
  const waterChance = waterWindow ? 0.035 + (customer.household_size ?? 2) * 0.006 : 0.002;
  const waterOn = rand01(hash32(`${customer.id}:${ts.toISOString().slice(0, 16)}`) ^ 205) < waterChance;
  const water = waterOn ? clamp(650 + rand01(seedBase ^ 206) * 850, 500, 1800) : 0;

  // Ar condicionado: depende da temperatura e hora
  const acEnabled = tempC >= 22 && hour >= 12 && hour <= 23.5;
  const ac = acEnabled ? clamp(220 + (tempC - 22) * 120 + rand01(seedBase ^ 207) * 140, 0, 1500) : 0;

  // Máquina de lavar: usa o evento de laundry existente se estiver ativo
  const wash = clamp(ongoingLaundryWatts, 0, 1200);

  return {
    [AP_FRIDGE]: fridge,
    [AP_WASH]: wash,
    [AP_LIGHTS]: lights,
    [AP_STANDBY]: standby,
    [AP_AC]: ac,
    [AP_WATER]: water
  } as Record<number, number>;
}

function scaleToTotal(totalWatts: number, byAppliance: Record<number, number>) {
  const entries = Object.entries(byAppliance);
  const sum = entries.reduce((acc, [, w]) => acc + w, 0);
  if (sum <= 0) return byAppliance;

  // Garante que a soma de equipamentos não ultrapassa 85% do total (deixa margem para “outros”).
  const target = Math.max(0, totalWatts * 0.85);
  const scale = Math.min(1, target / sum);
  const scaled: Record<number, number> = {};
  for (const [k, w] of entries) scaled[Number(k)] = Math.round(w * scale);
  return scaled;
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

              // Breakdown sintético por equipamento (para a página Equipamentos)
              const ongoing = eventByCustomer.get(customer.id);
              const laundryWatts = ongoing?.kind === 'laundry' && ongoing.remainingSteps > 0 ? ongoing.extraWatts : 0;
              const provisional = applianceWattsProvisional(customer, nextTs, tempC, laundryWatts);
              const byAppliance = scaleToTotal(nextWatts, provisional);

              const sessions = applianceSessionsByCustomer.get(customer.id) ?? new Map<number, ApplianceSessionState>();
              if (!applianceSessionsByCustomer.has(customer.id)) applianceSessionsByCustomer.set(customer.id, sessions);

              const usageDocs: Array<{
                customer_id: string;
                appliance_id: number;
                start_ts: Date;
                end_ts: Date;
                energy_wh: number;
                cost_eur: number;
                confidence: number;
                source: 'synthetic';
              }> = [];

              for (const [applianceIdStr, w] of Object.entries(byAppliance)) {
                const applianceId = Number(applianceIdStr);
                const threshold = applianceId === 5 ? 1 : 40; // stand-by conta sempre
                const isOn = w >= threshold;

                const state = sessions.get(applianceId) ?? { active: false, startTs: null, energyWh: 0, confidence: 0.85 };
                if (!sessions.has(applianceId)) sessions.set(applianceId, state);

                if (isOn) {
                  if (!state.active) {
                    state.active = true;
                    state.startTs = nextTs;
                    state.energyWh = 0;
                    state.confidence = applianceId === 5 ? 0.8 : 0.88;
                  }
                  state.energyWh += w * SAMPLE_INTERVAL_HOURS;
                } else if (state.active && state.startTs) {
                  const energyWh = state.energyWh;
                  const cost = (energyWh / 1000) * (customer.price_eur_per_kwh ?? 0.2);
                  usageDocs.push({
                    customer_id: customer.id,
                    appliance_id: applianceId,
                    start_ts: state.startTs,
                    end_ts: nextTs,
                    energy_wh: Number(energyWh.toFixed(3)),
                    cost_eur: Number(cost.toFixed(6)),
                    confidence: state.confidence,
                    source: 'synthetic'
                  });
                  state.active = false;
                  state.startTs = null;
                  state.energyWh = 0;
                }
              }

              if (usageDocs.length) {
                try {
                  await c.customerApplianceUsage.insertMany(usageDocs);
                } catch {
                  // ignora para não derrubar o job
                }
              }

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
