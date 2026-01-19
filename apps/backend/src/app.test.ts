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

describe('chat', () => {
  it('cria conversa e responde', async () => {
    const c = getCollections();

    const customerId = 'U_chat';
    await c.customers.insertOne({
      id: customerId,
      name: 'Cliente Chat',
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

    const res = await request(app).post(`/customers/${customerId}/chat`).send({ message: 'Olá! Quanto gastei nas últimas 24h?' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('conversationId');
    expect(res.body).toHaveProperty('reply');
    expect(typeof res.body.reply).toBe('string');

    const convId = String(res.body.conversationId);
    const history = await request(app).get(`/customers/${customerId}/chat?conversationId=${encodeURIComponent(convId)}&limit=50`);
    expect(history.status).toBe(200);
    expect(history.body).toHaveProperty('conversationId');
    expect(history.body.conversationId).toBe(convId);
    expect(Array.isArray(history.body.messages)).toBe(true);
    expect(history.body.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('follow-up "sim" sugere ações em vez de reiniciar', async () => {
    const c = getCollections();

    const customerId = 'U_chat_follow';
    await c.customers.insertOne({
      id: customerId,
      name: 'Cliente Follow',
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

    // precisa de telemetria para definir o "end" usado nas queries do chat
    const end = new Date('2026-01-15T00:00:00.000Z');
    await c.customerTelemetry15m.insertMany([
      { customer_id: customerId, ts: new Date(end.getTime() - 15 * 60 * 1000), watts: 900, euros: 0.0, temp_c: 15, is_estimated: false },
      { customer_id: customerId, ts: end, watts: 1100, euros: 0.0, temp_c: 15, is_estimated: false }
    ]);

    // sessões por equipamento (dentro da janela)
    const s = new Date(end.getTime() - 2 * 24 * 60 * 60 * 1000);
    await c.customerApplianceUsage.insertMany([
      {
        customer_id: customerId,
        appliance_id: 1,
        start_ts: s,
        end_ts: new Date(s.getTime() + 60 * 60 * 1000),
        energy_wh: 430,
        cost_eur: 0.05,
        confidence: 0.9,
        source: 'synthetic'
      },
      {
        customer_id: customerId,
        appliance_id: 7,
        start_ts: s,
        end_ts: new Date(s.getTime() + 45 * 60 * 1000),
        energy_wh: 290,
        cost_eur: 0.03,
        confidence: 0.85,
        source: 'synthetic'
      }
    ]);

    const first = await request(app).post(`/customers/${customerId}/chat`).send({ message: 'Qual o equipamento que mais consome?' });
    expect(first.status).toBe(200);
    expect(first.body).toHaveProperty('conversationId');
    expect(String(first.body.reply)).toContain('Quer que eu sugira 2 ações rápidas');

    const convId = String(first.body.conversationId);
    const follow = await request(app).post(`/customers/${customerId}/chat`).send({ message: 'sim', conversationId: convId });
    expect(follow.status).toBe(200);
    expect(String(follow.body.reply)).toContain('1)');
    expect(String(follow.body.reply)).toContain('2)');
    expect(String(follow.body.reply)).not.toContain('Quer que eu sugira 2 ações rápidas');
  });
});
