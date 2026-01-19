import { MongoClient, type Collection, type Db } from 'mongodb';

export type CustomerDoc = {
  id: string;
  name: string;
  segment: string;
  city: string;
  contracted_power_kva: number;
  tariff: string;
  utility: string;

  price_eur_per_kwh: number;
  fixed_daily_fee_eur: number;
  has_smart_meter: number;

  home_area_m2: number;
  household_size: number;
  locality_type: string;
  dwelling_type: string;
  build_year_band: string;
  heating_sources: string;
  has_solar: number;
  ev_count: number;
  alert_sensitivity: string;
  main_appliances: string;

  created_at: Date;
};

export type CustomerTelemetry15mDoc = {
  customer_id: string;
  ts: Date;
  watts: number;
  euros: number;
  temp_c: number | null;
  is_estimated: boolean;
};

export type Collections = {
  samples: Collection<{ ts: Date; watts: number; euros: number }>;
  telemetry15m: Collection<{ ts: Date; watts: number; euros: number }>;
  telemetryDaily: Collection<{ day: string; kwh: number; euros: number; peak_watts: number }>;
  nilmEvents: Collection<{ id: number; customer_id?: string; appliance_id?: number; label: string | null; status: string; confidence: number; watts: number; duration_min: number; created_at: Date }>;
  appliances: Collection<{ id: number; name: string; category: string; standby_watts: number; efficiency_score: number; annual_cost: number; created_at: Date }>;
  applianceUsage: Collection<{ id: number; appliance_id: number; start_ts: Date; end_ts: Date; energy_wh: number; cost_eur: number; confidence: number }>;
  customerApplianceUsage: Collection<{ customer_id: string; appliance_id: number; start_ts: Date; end_ts: Date; energy_wh: number; cost_eur: number; confidence: number; source?: 'synthetic' | 'estimated' }>; 
  chatConversations: Collection<{ id: string; customer_id: string; title: string | null; state?: any; created_at: Date; updated_at: Date }>;
  chatMessages: Collection<{ id: string; customer_id: string; conversation_id: string; role: 'user' | 'assistant' | 'system'; content: string; created_at: Date }>;
  alerts: Collection<{ id: number; message: string; severity: string; status: string; type: string; created_at: Date }>;
  advice: Collection<{ id: number; current_power: number; suggested_power: number; tariff: string; savings_per_month: number; created_at: Date }>;
  contractProfile: Collection<{ _id: 1; power_kva: number; tariff: string; utility: string; updated_at: Date }>;
  customers: Collection<CustomerDoc>;
  customerTelemetry15m: Collection<CustomerTelemetry15mDoc>;
};

let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;

function resolveDbNameFromUri(uri: string) {
  try {
    const u = new URL(uri);
    const dbName = (u.pathname ?? '').replace(/^\//, '');
    return dbName || undefined;
  } catch {
    return undefined;
  }
}

export async function initDb() {
  if (mongoDb) return mongoDb;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI não definido. Configure a ligação ao MongoDB antes de iniciar o backend.');
  }

  const dbName = process.env.MONGODB_DB ?? resolveDbNameFromUri(uri) ?? 'kynex';
  mongoClient = new MongoClient(uri);
  await mongoClient.connect();
  mongoDb = mongoClient.db(dbName);

  await ensureIndexesAndSeed(mongoDb);
  return mongoDb;
}

export function getDb() {
  if (!mongoDb) throw new Error('MongoDB ainda não inicializado. Chame initDb() primeiro.');
  return mongoDb;
}

export function getCollections(db: Db = getDb()): Collections {
  return {
    samples: db.collection('samples'),
    telemetry15m: db.collection('telemetry_15m'),
    telemetryDaily: db.collection('telemetry_daily'),
    nilmEvents: db.collection('nilm_events'),
    appliances: db.collection('appliances'),
    applianceUsage: db.collection('appliance_usage'),
    customerApplianceUsage: db.collection('customer_appliance_usage'),
    chatConversations: db.collection('chat_conversations'),
    chatMessages: db.collection('chat_messages'),
    alerts: db.collection('alerts'),
    advice: db.collection('advice'),
    contractProfile: db.collection('contract_profile'),
    customers: db.collection('customers'),
    customerTelemetry15m: db.collection('customer_telemetry_15m')
  };
}

export async function closeDb() {
  await mongoClient?.close();
  mongoClient = null;
  mongoDb = null;
}

async function ensureIndexesAndSeed(db: Db) {
  const c = getCollections(db);

  await Promise.all([
    c.samples.createIndex({ ts: 1 }),
    c.telemetry15m.createIndex({ ts: 1 }),
    c.telemetryDaily.createIndex({ day: 1 }),
    c.nilmEvents.createIndex({ id: 1 }, { unique: true }),
    c.appliances.createIndex({ id: 1 }, { unique: true }),
    c.applianceUsage.createIndex({ id: 1 }, { unique: true }),
    c.applianceUsage.createIndex({ appliance_id: 1, start_ts: -1 }),
    c.customerApplianceUsage.createIndex({ customer_id: 1, appliance_id: 1, start_ts: -1 }),
    c.customerApplianceUsage.createIndex({ customer_id: 1, start_ts: -1 }),
    c.chatConversations.createIndex({ id: 1 }, { unique: true }),
    c.chatConversations.createIndex({ customer_id: 1, updated_at: -1 }),
    c.chatMessages.createIndex({ id: 1 }, { unique: true }),
    c.chatMessages.createIndex({ conversation_id: 1, created_at: 1 }),
    c.chatMessages.createIndex({ customer_id: 1, created_at: 1 }),
    c.alerts.createIndex({ id: 1 }, { unique: true }),
    c.alerts.createIndex({ created_at: -1 }),
    c.advice.createIndex({ id: 1 }, { unique: true }),
    c.advice.createIndex({ created_at: -1 }),
    c.customers.createIndex({ id: 1 }, { unique: true }),
    c.customers.createIndex({ created_at: -1 }),
    c.customerTelemetry15m.createIndex({ customer_id: 1, ts: -1 })
  ]);

  // Seed dos dados globais (não dos clientes). Clientes novos continuam a começar sem telemetria.
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  const latestAgg = await c.telemetry15m.find({}, { projection: { ts: 1 } }).sort({ ts: -1 }).limit(1).toArray();
  const latestTs = latestAgg[0]?.ts;

  if (latestTs && latestTs.getTime() > Date.now() - oneHour) {
    // OK: dados recentes
    return;
  }

  await Promise.all([
    c.samples.deleteMany({}),
    c.telemetry15m.deleteMany({}),
    c.telemetryDaily.deleteMany({}),
    c.nilmEvents.deleteMany({}),
    c.appliances.deleteMany({}),
    c.applianceUsage.deleteMany({}),
    c.alerts.deleteMany({}),
    c.advice.deleteMany({}),
    c.contractProfile.deleteMany({})
  ]);

  const rate = 0.2;
  const samples = [] as Array<{ ts: Date; watts: number; euros: number }>;
  const telemetry15m = [] as Array<{ ts: Date; watts: number; euros: number }>;

  for (let i = 0; i < 96; i += 1) {
    const ts = new Date(now - (95 - i) * 15 * 60 * 1000);
    const base = 280 + (Math.sin(i / 8) + 1) * 160;
    const spike = i === 70 ? 2200 : i === 30 ? 1400 : 0;
    const watts = Math.round(base + spike + Math.random() * 50);
    const euros = ((watts / 1000) * rate) / 4;
    samples.push({ ts, watts, euros });
    telemetry15m.push({ ts, watts, euros });
  }

  await c.samples.insertMany(samples);
  await c.telemetry15m.insertMany(telemetry15m);

  await c.telemetryDaily.insertOne({
    day: new Date(now).toISOString().slice(0, 10),
    kwh: 9.4,
    euros: 1.88,
    peak_watts: 2600
  });

  await c.nilmEvents.insertMany([
    { id: 1, label: null, status: 'pending', confidence: 0.72, watts: 2400, duration_min: 45, created_at: new Date(now - 2 * 60 * 60 * 1000) },
    { id: 2, label: 'Máquina de lavar', status: 'confirmed', confidence: 0.88, watts: 1200, duration_min: 60, created_at: new Date(now - 6 * 60 * 60 * 1000) },
    { id: 3, label: 'Forno', status: 'confirmed', confidence: 0.81, watts: 2100, duration_min: 50, created_at: new Date(now - 24 * 60 * 60 * 1000) }
  ]);

  const createdAt = new Date(now - 7 * 24 * 60 * 60 * 1000);
  await c.appliances.insertMany([
    { id: 1, name: 'Frigorífico/Arca', category: 'frio', standby_watts: 5, efficiency_score: 0.9, annual_cost: 120, created_at: createdAt },
    { id: 2, name: 'Aquecedor (genérico)', category: 'climatizacao', standby_watts: 2, efficiency_score: 0.5, annual_cost: 320, created_at: createdAt },
    { id: 3, name: 'Máquina de lavar roupa', category: 'lavandaria', standby_watts: 1, efficiency_score: 0.8, annual_cost: 95, created_at: createdAt },
    { id: 4, name: 'Luz', category: 'iluminacao', standby_watts: 0, efficiency_score: 0.85, annual_cost: 55, created_at: createdAt },
    { id: 5, name: 'Stand-by', category: 'standby', standby_watts: 40, efficiency_score: 0.6, annual_cost: 110, created_at: createdAt },
    { id: 6, name: 'Ar Condicionado', category: 'climatizacao', standby_watts: 3, efficiency_score: 0.7, annual_cost: 210, created_at: createdAt },
    { id: 7, name: 'Água quente (Termoacumulador)', category: 'agua_quente', standby_watts: 2, efficiency_score: 0.65, annual_cost: 260, created_at: createdAt }
  ]);

  await c.applianceUsage.insertMany([
    { id: 1, appliance_id: 1, start_ts: new Date(now - 5 * 60 * 60 * 1000), end_ts: new Date(now - 4.5 * 60 * 60 * 1000), energy_wh: 180, cost_eur: 0.04, confidence: 0.9 },
    { id: 2, appliance_id: 2, start_ts: new Date(now - 3 * 60 * 60 * 1000), end_ts: new Date(now - 2 * 60 * 60 * 1000), energy_wh: 1800, cost_eur: 0.36, confidence: 0.7 },
    { id: 3, appliance_id: 3, start_ts: new Date(now - 25 * 60 * 60 * 1000), end_ts: new Date(now - 24 * 60 * 60 * 1000), energy_wh: 900, cost_eur: 0.18, confidence: 0.8 }
  ]);

  await c.alerts.insertMany([
    {
      id: 1,
      message: 'Prancha de cabelo ligada em casa vazia. Sugestão: desligar tomada smart plug.',
      severity: 'critical',
      status: 'open',
      type: 'safety',
      created_at: new Date(now - 15 * 60 * 1000)
    },
    {
      id: 2,
      message: 'Standby elevado detectado no frigorífico (acima da média da tipologia).',
      severity: 'warning',
      status: 'open',
      type: 'efficiency',
      created_at: new Date(now - 4 * 60 * 60 * 1000)
    }
  ]);

  await c.advice.insertOne({
    id: 1,
    current_power: 6.9,
    suggested_power: 4.6,
    tariff: 'Bi-horário',
    savings_per_month: 7.5,
    created_at: new Date(now)
  });

  await c.contractProfile.updateOne(
    { _id: 1 },
    {
      $set: { power_kva: 6.9, tariff: 'Simples', utility: 'EDP', updated_at: new Date(now) },
      $setOnInsert: { _id: 1 }
    },
    { upsert: true }
  );
}
