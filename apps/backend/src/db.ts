import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let db: Database.Database | null = null;

const ensureDatabase = () => {
  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'app.db');
  return dbPath;
};

const ensureColumn = (database: Database.Database, table: string, column: string, definition: string) => {
  const info = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = info.some((c) => c.name === column);
  if (!exists) {
    database.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
};

const createTables = (database: Database.Database) => {
  database.prepare(
    `CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      watts REAL NOT NULL,
      euros REAL NOT NULL
    )`
  ).run();

  database.prepare(
    `CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      segment TEXT NOT NULL,
      city TEXT NOT NULL,
      contracted_power_kva REAL NOT NULL,
      tariff TEXT NOT NULL,
      utility TEXT NOT NULL,
      price_eur_per_kwh REAL NOT NULL DEFAULT 0.2,
      fixed_daily_fee_eur REAL NOT NULL DEFAULT 0,
      has_smart_meter INTEGER NOT NULL DEFAULT 1,
      home_area_m2 REAL NOT NULL DEFAULT 80,
      household_size INTEGER NOT NULL DEFAULT 2,
      locality_type TEXT NOT NULL DEFAULT 'Urbana',
      dwelling_type TEXT NOT NULL DEFAULT 'Apartamento',
      build_year_band TEXT NOT NULL DEFAULT '2000-2014',
      heating_sources TEXT NOT NULL DEFAULT '',
      has_solar INTEGER NOT NULL DEFAULT 0,
      ev_count INTEGER NOT NULL DEFAULT 0,
      alert_sensitivity TEXT NOT NULL DEFAULT 'Média',
      main_appliances TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`
  ).run();

  // Compatibilidade: adiciona colunas se a tabela já existir (SQLite não suporta ADD COLUMN NOT NULL sem DEFAULT)
  ensureColumn(database, 'customers', 'home_area_m2', 'REAL NOT NULL DEFAULT 80');
  ensureColumn(database, 'customers', 'household_size', 'INTEGER NOT NULL DEFAULT 2');
  ensureColumn(database, 'customers', 'locality_type', "TEXT NOT NULL DEFAULT 'Urbana'");
  ensureColumn(database, 'customers', 'dwelling_type', "TEXT NOT NULL DEFAULT 'Apartamento'");
  ensureColumn(database, 'customers', 'build_year_band', "TEXT NOT NULL DEFAULT '2000-2014'");
  ensureColumn(database, 'customers', 'heating_sources', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'customers', 'has_solar', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'customers', 'ev_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'customers', 'has_smart_meter', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(database, 'customers', 'price_eur_per_kwh', 'REAL NOT NULL DEFAULT 0.2');
  ensureColumn(database, 'customers', 'fixed_daily_fee_eur', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(database, 'customers', 'alert_sensitivity', "TEXT NOT NULL DEFAULT 'Média'");
  ensureColumn(database, 'customers', 'main_appliances', "TEXT NOT NULL DEFAULT ''");

  database.prepare(
    `CREATE TABLE IF NOT EXISTS customer_telemetry_15m (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      watts REAL NOT NULL,
      euros REAL NOT NULL,
      temp_c REAL,
      is_estimated INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(customer_id) REFERENCES customers(id)
    )`
  ).run();

  database.prepare(
    'CREATE INDEX IF NOT EXISTS idx_customer_telemetry_15m_customer_ts ON customer_telemetry_15m(customer_id, ts)'
  ).run();

  database.prepare(
    `CREATE TABLE IF NOT EXISTS telemetry_15m (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      watts REAL NOT NULL,
      euros REAL NOT NULL
    )`
  ).run();

  database.prepare(
    `CREATE TABLE IF NOT EXISTS telemetry_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      kwh REAL NOT NULL,
      euros REAL NOT NULL,
      peak_watts REAL NOT NULL
    )`
  ).run();

  database.prepare(
    `CREATE TABLE IF NOT EXISTS nilm_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      watts REAL NOT NULL,
      duration_min REAL NOT NULL,
      created_at TEXT NOT NULL
    )`
  ).run();

  database.prepare(
    `CREATE TABLE IF NOT EXISTS appliances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      standby_watts REAL NOT NULL,
      efficiency_score REAL NOT NULL,
      annual_cost REAL NOT NULL,
      created_at TEXT NOT NULL
    )`
  ).run();

  database.prepare(
    `CREATE TABLE IF NOT EXISTS appliance_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appliance_id INTEGER NOT NULL,
      start_ts TEXT NOT NULL,
      end_ts TEXT NOT NULL,
      energy_wh REAL NOT NULL,
      cost_eur REAL NOT NULL,
      confidence REAL NOT NULL,
      FOREIGN KEY(appliance_id) REFERENCES appliances(id)
    )`
  ).run();

  database.prepare(
    `CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  ).run();

  ensureColumn(database, 'alerts', 'type', "TEXT NOT NULL DEFAULT 'safety'");

  database.prepare(
    `CREATE TABLE IF NOT EXISTS advice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      current_power REAL NOT NULL,
      suggested_power REAL NOT NULL,
      tariff TEXT NOT NULL,
      savings_per_month REAL NOT NULL,
      created_at TEXT NOT NULL
    )`
  ).run();

  database.prepare(
    `CREATE TABLE IF NOT EXISTS contract_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      power_kva REAL NOT NULL,
      tariff TEXT NOT NULL,
      utility TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  ).run();
};

const seedData = (database: Database.Database) => {
  const sampleCount = database.prepare('SELECT COUNT(*) as count FROM samples').get() as { count: number };
  const aggCount = database.prepare('SELECT COUNT(*) as count FROM telemetry_15m').get() as { count: number };
  if (sampleCount.count > 0 && aggCount.count > 0) {
    const latest = database
      .prepare('SELECT ts FROM telemetry_15m ORDER BY ts DESC LIMIT 1')
      .get() as { ts: string } | undefined;

    // Se o DB persistir entre runs, os timestamps podem ficar antigos e os endpoints (range last 24h) devolvem vazio.
    // Re-seeda a telemetria quando o último ponto é muito antigo.
    if (latest) {
      const lastMs = Date.parse(latest.ts);
      const oneHour = 60 * 60 * 1000;
      if (!Number.isNaN(lastMs) && lastMs > Date.now() - oneHour) return;
    }

    database.prepare('DELETE FROM telemetry_15m').run();
    database.prepare('DELETE FROM samples').run();
    database.prepare('DELETE FROM telemetry_daily').run();
  }

  const rate = 0.2; // €/kWh assumido
  const now = Date.now();

  const insertSample = database.prepare('INSERT INTO samples (ts, watts, euros) VALUES (?, ?, ?)');
  const insert15m = database.prepare('INSERT INTO telemetry_15m (ts, watts, euros) VALUES (?, ?, ?)');

  for (let i = 0; i < 96; i += 1) {
    const ts = new Date(now - (95 - i) * 15 * 60 * 1000).toISOString();
    const base = 280 + (Math.sin(i / 8) + 1) * 160; // variação suave
    const spike = i === 70 ? 2200 : i === 30 ? 1400 : 0;
    const watts = Math.round(base + spike + Math.random() * 50);
    const euros = ((watts / 1000) * rate) / 4; // 15m
    insertSample.run(ts, watts, euros);
    insert15m.run(ts, watts, euros);
  }

  database
    .prepare('INSERT INTO telemetry_daily (day, kwh, euros, peak_watts) VALUES (?, ?, ?, ?)')
    .run(new Date(now).toISOString().slice(0, 10), 9.4, 1.88, 2600);

  const insertEvent = database.prepare(
    'INSERT INTO nilm_events (label, status, confidence, watts, duration_min, created_at) VALUES (?, ?, ?, ?, ?, ?)' 
  );
  insertEvent.run(null, 'pending', 0.72, 2400, 45, new Date(now - 2 * 60 * 60 * 1000).toISOString());
  insertEvent.run('Máquina de lavar', 'confirmed', 0.88, 1200, 60, new Date(now - 6 * 60 * 60 * 1000).toISOString());
  insertEvent.run('Forno', 'confirmed', 0.81, 2100, 50, new Date(now - 24 * 60 * 60 * 1000).toISOString());

  const insertAppliance = database.prepare(
    'INSERT INTO appliances (name, category, standby_watts, efficiency_score, annual_cost, created_at) VALUES (?, ?, ?, ?, ?, ?)' 
  );
  const createdAt = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  insertAppliance.run('Frigorífico', 'frio', 5, 0.9, 120, createdAt);
  insertAppliance.run('Aquecedor', 'climatizacao', 2, 0.5, 320, createdAt);
  insertAppliance.run('Máquina de lavar roupa', 'lavandaria', 1, 0.8, 95, createdAt);

  const insertUsage = database.prepare(
    'INSERT INTO appliance_usage (appliance_id, start_ts, end_ts, energy_wh, cost_eur, confidence) VALUES (?, ?, ?, ?, ?, ?)' 
  );
  insertUsage.run(1, new Date(now - 5 * 60 * 60 * 1000).toISOString(), new Date(now - 4.5 * 60 * 60 * 1000).toISOString(), 180, 0.04, 0.9);
  insertUsage.run(2, new Date(now - 3 * 60 * 60 * 1000).toISOString(), new Date(now - 2 * 60 * 60 * 1000).toISOString(), 1800, 0.36, 0.7);
  insertUsage.run(3, new Date(now - 25 * 60 * 60 * 1000).toISOString(), new Date(now - 24 * 60 * 60 * 1000).toISOString(), 900, 0.18, 0.8);

  const insertAlert = database.prepare(
    'INSERT INTO alerts (message, severity, status, type, created_at) VALUES (?, ?, ?, ?, ?)' 
  );
  insertAlert.run(
    'Prancha de cabelo ligada em casa vazia. Sugestão: desligar tomada smart plug.',
    'critical',
    'open',
    'safety',
    new Date(now - 15 * 60 * 1000).toISOString()
  );
  insertAlert.run(
    'Standby elevado detectado no frigorífico (acima da média da tipologia).',
    'warning',
    'open',
    'efficiency',
    new Date(now - 4 * 60 * 60 * 1000).toISOString()
  );

  const insertAdvice = database.prepare(
    'INSERT INTO advice (current_power, suggested_power, tariff, savings_per_month, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertAdvice.run(6.9, 4.6, 'Bi-horário', 7.5, new Date(now).toISOString());

  database
    .prepare('INSERT OR REPLACE INTO contract_profile (id, power_kva, tariff, utility, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run(6.9, 'Simples', 'EDP', new Date(now).toISOString());
};

export const getDb = () => {
  if (db) return db;

  const dbPath = ensureDatabase();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  createTables(db);
  seedData(db);

  return db;
};
