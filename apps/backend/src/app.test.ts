import request from 'supertest';
import app from './app';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { closeDb, getCollections, initDb } from './db';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'kynex_test';
  await initDb();
});

afterAll(async () => {
  await closeDb();
  await mongod.stop();
});

describe('health', () => {
  it('responde ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('telemetry', () => {
  it('retorna leitura atual', async () => {
    const res = await request(app).get('/telemetry/now');
    expect(res.status).toBe(200);
    expect(res.body.watts).toBeGreaterThan(0);
    expect(res.body.eurosPerHour).toBeGreaterThan(0);
    expect(res.body.forecastMonthly).toBeGreaterThan(0);
  });

  it('retorna intervalo 15m', async () => {
    const res = await request(app).get('/telemetry/range?bucket=15m');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

describe('appliances', () => {
  it('lista aparelhos com uso', async () => {
    const res = await request(app).get('/appliances');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('usage_wh');
  });
});

describe('analytics', () => {
  it('retorna eficiência horária', async () => {
    const c = getCollections();

    const customerId = 'U_test';
    await c.customers.insertOne({
      id: customerId,
      name: 'Cliente Teste',
      segment: 'residential',
      city: 'Porto',
      contracted_power_kva: 6.9,
      tariff: 'Bi-horário',
      utility: 'EDP',
      price_eur_per_kwh: 0.2,
      fixed_daily_fee_eur: 0,
      has_smart_meter: 1,
      home_area_m2: 80,
      household_size: 2,
      locality_type: 'Urbana',
      dwelling_type: 'Apartamento',
      build_year_band: '2000-2014',
      heating_sources: 'Elétrico',
      has_solar: 0,
      ev_count: 0,
      alert_sensitivity: 'Média',
      main_appliances: 'Termoacumulador',
      created_at: new Date('2026-01-01T00:00:00.000Z')
    });

    const start = new Date('2026-01-10T00:00:00.000Z');
    const docs = [] as Array<{ customer_id: string; ts: Date; watts: number; euros: number; temp_c: number | null; is_estimated: boolean }>;
    for (let i = 0; i < 2 * 24 * 4; i += 1) {
      const ts = new Date(start.getTime() + i * 15 * 60 * 1000);
      const hour = ts.getUTCHours();
      const watts = hour >= 18 && hour <= 21 ? 2200 : hour >= 0 && hour <= 7 ? 900 : 1300;
      docs.push({ customer_id: customerId, ts, watts, euros: 0.0, temp_c: 15, is_estimated: false });
    }
    await c.customerTelemetry15m.insertMany(docs);

    const res = await request(app).get(`/customers/${customerId}/analytics/hourly-efficiency?days=7`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('scorePct');
    expect(res.body).toHaveProperty('avgKwhByHourUtc');
    expect(Array.isArray(res.body.avgKwhByHourUtc)).toBe(true);
    expect(res.body.avgKwhByHourUtc.length).toBe(24);
  });
});
