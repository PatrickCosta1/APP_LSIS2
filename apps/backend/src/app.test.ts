import request from 'supertest';
import app from './app';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { closeDb, getCollections, initDb } from './db';
import { hashToken } from './auth';

let mongod: MongoMemoryServer;

async function seedAuth(customerId: string) {
  const c = getCollections();
  const userId = `USR_${customerId}`;
  const token = `test-token-${customerId}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  await c.users.insertOne({
    id: userId,
    customer_id: customerId,
    email: `${customerId}@test.local`,
    password_salt_b64: 'test_salt',
    password_hash_b64: 'test_hash',
    created_at: now
  });

  await c.authSessions.insertOne({
    id: `SES_${customerId}`,
    user_id: userId,
    customer_id: customerId,
    token_hash: hashToken(token),
    created_at: now,
    expires_at: expiresAt,
    last_seen_at: now
  });

  return token;
}

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

    const token = await seedAuth(customerId);
    const res = await request(app)
      .get(`/customers/${customerId}/analytics/hourly-efficiency?days=7`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('scorePct');
    expect(res.body).toHaveProperty('avgKwhByHourUtc');
    expect(Array.isArray(res.body.avgKwhByHourUtc)).toBe(true);
    expect(res.body.avgKwhByHourUtc.length).toBe(24);
  });
});

describe('appliances weekly', () => {
  it('retorna consumo diário por equipamento (7 dias) e dica', async () => {
    const c = getCollections();

    const customerId = 'U_appl_week';
    await c.customers.insertOne({
      id: customerId,
      name: 'Cliente Weekly',
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
      main_appliances: 'Frigorífico',
      created_at: new Date('2026-01-01T00:00:00.000Z')
    });

    // telemetria para definir o "now" simulado
    const end = new Date('2026-01-15T12:00:00.000Z');
    await c.customerTelemetry15m.insertMany([
      { customer_id: customerId, ts: new Date(end.getTime() - 15 * 60 * 1000), watts: 900, euros: 0.0, temp_c: 15, is_estimated: false },
      { customer_id: customerId, ts: end, watts: 1100, euros: 0.0, temp_c: 15, is_estimated: false }
    ]);

    // sessões em 2 dias dentro da janela de 7 (uma em vazio, outra em pico)
    const d1 = new Date('2026-01-13T23:00:00.000Z'); // vazio
    const d2 = new Date('2026-01-14T19:00:00.000Z'); // pico
    await c.customerApplianceUsage.insertMany([
      { customer_id: customerId, appliance_id: 1, start_ts: d1, end_ts: new Date(d1.getTime() + 60 * 60 * 1000), energy_wh: 700, cost_eur: 0.12, confidence: 0.9, source: 'synthetic' },
      { customer_id: customerId, appliance_id: 1, start_ts: d2, end_ts: new Date(d2.getTime() + 30 * 60 * 1000), energy_wh: 400, cost_eur: 0.08, confidence: 0.85, source: 'synthetic' }
    ]);

    const token = await seedAuth(customerId);
    const res = await request(app)
      .get(`/customers/${customerId}/appliances/1/weekly?days=7`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('customerId', customerId);
    expect(res.body).toHaveProperty('applianceId', 1);
    expect(res.body).toHaveProperty('days', 7);
    expect(Array.isArray(res.body.daily)).toBe(true);
    expect(res.body.daily.length).toBe(7);
    expect(typeof res.body.tip).toBe('string');
    expect(res.body.tip.length).toBeGreaterThan(5);
    // dica deve ser curta e acionável (sem virar relatório)
    expect(res.body.tip.length).toBeLessThanOrEqual(160);
    expect(String(res.body.tip).toLowerCase()).toMatch(/agende|evite|reduza|desligue|use|concentre|mantenha|confirme/);
    expect(String(res.body.tip)).not.toMatch(/kwh|€|%|\/mês/i);
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

    const token = await seedAuth(customerId);
    const res = await request(app)
      .post(`/customers/${customerId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Olá! Quanto gastei nas últimas 24h?' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('conversationId');
    expect(res.body).toHaveProperty('reply');
    expect(typeof res.body.reply).toBe('string');

    const convId = String(res.body.conversationId);
    const history = await request(app)
      .get(`/customers/${customerId}/chat?conversationId=${encodeURIComponent(convId)}&limit=50`)
      .set('Authorization', `Bearer ${token}`);
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

    const token = await seedAuth(customerId);
    const first = await request(app)
      .post(`/customers/${customerId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Qual o equipamento que mais consome?' });
    expect(first.status).toBe(200);
    expect(first.body).toHaveProperty('conversationId');
    expect(String(first.body.reply)).toContain('Quer que eu sugira 2 ações rápidas');

    const convId = String(first.body.conversationId);
    const follow = await request(app)
      .post(`/customers/${customerId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'sim', conversationId: convId });
    expect(follow.status).toBe(200);
    expect(String(follow.body.reply)).toContain('1)');
    expect(String(follow.body.reply)).toContain('2)');
    expect(String(follow.body.reply)).not.toContain('Quer que eu sugira 2 ações rápidas');
  });

  it('ações de feedback registam e respondem', async () => {
    const c = getCollections();

    const customerId = 'U_chat_fb';
    await c.customers.insertOne({
      id: customerId,
      name: 'Cliente Feedback',
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

    const end = new Date('2026-01-15T00:00:00.000Z');
    await c.customerTelemetry15m.insertMany([
      { customer_id: customerId, ts: new Date(end.getTime() - 15 * 60 * 1000), watts: 900, euros: 0.0, temp_c: 15, is_estimated: false },
      { customer_id: customerId, ts: end, watts: 1100, euros: 0.0, temp_c: 15, is_estimated: false }
    ]);

    const token = await seedAuth(customerId);
    const first = await request(app)
      .post(`/customers/${customerId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Quanto gastei nas últimas 24h?' });
    expect(first.status).toBe(200);
    const convId = String(first.body.conversationId);

    const fb = await request(app)
      .post(`/customers/${customerId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '__ACTION:FEEDBACK:UP__', conversationId: convId });
    expect(fb.status).toBe(200);
    expect(String(fb.body.reply)).toContain('obrigado');

    const rows = await c.assistantFeedback.find({ customer_id: customerId }).toArray();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('"porquê?" explica a última sugestão (com contexto)', async () => {
    const c = getCollections();

    const customerId = 'U_chat_explain';
    await c.customers.insertOne({
      id: customerId,
      name: 'Cliente Explica',
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

    const end = new Date('2026-01-15T00:00:00.000Z');
    await c.customerTelemetry15m.insertMany([
      { customer_id: customerId, ts: new Date(end.getTime() - 15 * 60 * 1000), watts: 900, euros: 0.0, temp_c: 15, is_estimated: false },
      { customer_id: customerId, ts: end, watts: 1100, euros: 0.0, temp_c: 15, is_estimated: false }
    ]);

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
      }
    ]);

    const token = await seedAuth(customerId);
    const first = await request(app)
      .post(`/customers/${customerId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Qual o equipamento que mais consome?' });
    expect(first.status).toBe(200);
    expect(first.body).toHaveProperty('conversationId');

    const convId = String(first.body.conversationId);
    const explain = await request(app)
      .post(`/customers/${customerId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'porquê?', conversationId: convId });
    expect(explain.status).toBe(200);
    expect(String(explain.body.reply)).toContain('Eu baseio o ranking');
    expect(Array.isArray(explain.body.actions)).toBe(true);
  });

  it('ação de plano 7 dias devolve checklist', async () => {
    const c = getCollections();

    const customerId = 'U_chat_plan';
    await c.customers.insertOne({
      id: customerId,
      name: 'Cliente Plano',
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

    const token = await seedAuth(customerId);
    const res = await request(app)
      .post(`/customers/${customerId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '__ACTION:PLAN_7D__' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reply');
    expect(Array.isArray(res.body.actions)).toBe(true);
    const plan = (res.body.actions as any[]).find((a) => a && a.kind === 'plan');
    expect(plan).toBeTruthy();
    expect(plan).toHaveProperty('items');
    expect(Array.isArray(plan.items)).toBe(true);
    expect(plan.items.length).toBeGreaterThanOrEqual(5);
  });

  it('follow-up "sim" após 7 dias mostra eficiência', async () => {
    const c = getCollections();

    const customerId = 'U_chat_eff';
    await c.customers.insertOne({
      id: customerId,
      name: 'Cliente Eficiência',
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
    for (let i = 0; i < 7 * 24 * 4; i += 1) {
      const ts = new Date(start.getTime() + i * 15 * 60 * 1000);
      const hour = ts.getUTCHours();
      const watts = hour >= 18 && hour <= 21 ? 2200 : hour >= 0 && hour <= 7 ? 900 : 1300;
      docs.push({ customer_id: customerId, ts, watts, euros: 0.0, temp_c: 15, is_estimated: false });
    }
    await c.customerTelemetry15m.insertMany(docs);

    const token = await seedAuth(customerId);
    const first = await request(app)
      .post(`/customers/${customerId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Quanto gastei na última semana?' });
    expect(first.status).toBe(200);
    expect(first.body).toHaveProperty('conversationId');
    expect(String(first.body.reply)).toContain('Quer ver as melhores horas');

    const convId = String(first.body.conversationId);
    const follow = await request(app)
      .post(`/customers/${customerId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'sim', conversationId: convId });
    expect(follow.status).toBe(200);
    expect(String(follow.body.reply)).toContain('Eficiência horária');
  });
});

describe('assistant', () => {
  it('guarda e lê preferências do assistente', async () => {
    const c = getCollections();
    const customerId = 'U_prefs';
    await c.customers.insertOne({
      id: customerId,
      name: 'Cliente Prefs',
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

    const token = await seedAuth(customerId);
    const put = await request(app)
      .put(`/customers/${customerId}/assistant/prefs`)
      .set('Authorization', `Bearer ${token}`)
      .send({ style: 'short', focus: 'poupanca' });
    expect(put.status).toBe(200);

    const get = await request(app)
      .get(`/customers/${customerId}/assistant/prefs`)
      .set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body).toHaveProperty('style', 'short');
    expect(get.body).toHaveProperty('focus', 'poupanca');
  });

  it('retorna notificações proativas quando há telemetria', async () => {
    const c = getCollections();
    const customerId = 'U_notifs';
    await c.customers.insertOne({
      id: customerId,
      name: 'Cliente Notifs',
      segment: 'residential',
      city: 'Porto',
      contracted_power_kva: 3.45,
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

    const end = new Date('2026-01-15T06:00:00.000Z');
    const docs = [] as Array<{ customer_id: string; ts: Date; watts: number; euros: number; temp_c: number | null; is_estimated: boolean }>;
    // 2 dias de telemetria: dia atual com consumo maior e pico alto
    for (let i = 0; i < 2 * 24 * 4; i += 1) {
      const ts = new Date(end.getTime() - (2 * 24 * 4 - 1 - i) * 15 * 60 * 1000);
      const hour = ts.getUTCHours();
      const watts = hour >= 18 && hour <= 21 ? 3400 : hour >= 2 && hour <= 5 ? 260 : 1200;
      docs.push({ customer_id: customerId, ts, watts, euros: 0.0, temp_c: 15, is_estimated: false });
    }
    await c.customerTelemetry15m.insertMany(docs);

    const token = await seedAuth(customerId);
    const res = await request(app)
      .get(`/customers/${customerId}/assistant/notifications`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('notifications');
    expect(Array.isArray(res.body.notifications)).toBe(true);
  });
});
