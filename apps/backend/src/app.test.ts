import request from 'supertest';
import app from './app';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { closeDb, initDb } from './db';

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
