import crypto from 'node:crypto';
import { getCollections, initDb } from './db';
import { extractNilmSessions15m, inferFromFingerprints, type CustomerNilmFingerprintDoc } from './nilmService';

const DEFAULT_TICK_MS = 10 * 60 * 1000; // 10 min

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
}

function addUtcDays(d: Date, days: number) {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

export function startNilmJob() {
  const tickMs = Math.max(30_000, Number(process.env.KYNEX_NILM_TICK_MS ?? DEFAULT_TICK_MS));

  async function tick() {
    const db = await initDb();
    const cols = getCollections(db);

    const customers = await cols.customers.find({}, { projection: { _id: 0, id: 1, city: 1, price_eur_per_kwh: 1, fixed_daily_fee_eur: 1 } }).toArray();
    if (!customers.length) return;

    // processa no máximo N clientes por tick
    const maxPerTick = Math.max(1, Math.min(10, Number(process.env.KYNEX_NILM_MAX_CUSTOMERS_PER_TICK ?? 4)));

    for (const c of customers.slice(0, maxPerTick)) {
      const customerId = String((c as any).id);
      const price = typeof (c as any).price_eur_per_kwh === 'number' ? Number((c as any).price_eur_per_kwh) : 0.2;

      // janela curta para manter fingerprints atualizados (últimos 30 dias)
      const latest = await cols.customerTelemetry15m
        .find({ customer_id: customerId }, { projection: { _id: 0, ts: 1 } })
        .sort({ ts: -1 })
        .limit(1)
        .toArray();

      const latestTs = latest[0]?.ts ? new Date(latest[0].ts) : null;
      if (!latestTs) continue;

      const endDay = startOfUtcDay(latestTs);
      const start = addUtcDays(endDay, -30);

      const telRows = await cols.customerTelemetry15m
        .find({ customer_id: customerId, ts: { $gte: start, $lte: latestTs } }, { projection: { _id: 0, ts: 1, watts: 1 } })
        .sort({ ts: 1 })
        .toArray();

      const points = (telRows as any[]).map((r) => ({ ts: new Date(r.ts), watts: Number(r.watts ?? 0) }));
      const { baselineWatts, sessions } = extractNilmSessions15m(points);

      const baselineKwh = (Math.max(0, baselineWatts) * points.length * 0.25) / 1000;

      // carrega fingerprints existentes
      const known = await cols.customerNilmFingerprints
        .find({ customer_id: customerId }, { projection: { _id: 0 } })
        .limit(200)
        .toArray();

      const knownFingerprints = (known as any[]) as CustomerNilmFingerprintDoc[];

      // mapa de labels do utilizador
      const labeled = await cols.customerNilmSessions
        .find({ customer_id: customerId, label: { $ne: null } }, { projection: { _id: 0, id: 1, label: 1 } })
        .toArray();

      const labelsBySession = new Map<string, string | null>();
      for (const row of labeled as any[]) labelsBySession.set(String(row.id), row.label ? String(row.label) : null);

      const inferred = inferFromFingerprints({
        customerId,
        sessions,
        priceEurPerKwh: price,
        knownFingerprints,
        maxAppliances: 10,
        userLabelsBySessionId: labelsBySession,
        baselineKwh
      });

      // upsert fingerprints
      if (inferred.updatedFingerprints.length) {
        await cols.customerNilmFingerprints.bulkWrite(
          inferred.updatedFingerprints.map((fp) => ({
            updateOne: {
              filter: { customer_id: customerId, id: fp.id },
              update: { $set: fp, $setOnInsert: { created_at: fp.created_at ?? new Date() } },
              upsert: true
            }
          })),
          { ordered: false }
        );
      }

      // insere sessões recentes (best-effort)
      const now = new Date();
      const sessionDocs = inferred.sessions.slice(0, 600).map((s) => ({
        id: s.sessionId,
        customer_id: customerId,
        start_ts: s.startTs,
        end_ts: s.endTs,
        features: {
          duration_min: s.durationMin,
          mean_watts: s.meanWatts,
          peak_watts: s.peakWatts,
          energy_wh: s.energyWh,
          start_step_watts: s.startStepWatts,
          start_hour_utc: s.startTs.getUTCHours(),
          start_dow: (s.startTs.getUTCDay() + 6) % 7
        },
        fingerprint_id: s.fingerprintId,
        inferred_name: s.inferredLabel,
        inferred_category: null,
        confidence: s.confidence,
        label: s.userLabel,
        created_at: now,
        updated_at: now
      }));

      if (sessionDocs.length) {
        await cols.customerNilmSessions.bulkWrite(
          sessionDocs.map((d) => ({
            updateOne: {
              filter: { customer_id: customerId, id: d.id },
              update: {
                $set: { ...d, updated_at: now },
                $setOnInsert: { created_at: now }
              },
              upsert: true
            }
          })),
          { ordered: false }
        );
      }

      // anomalias simples (gera notificação se um fingerprint rotulado subir +20% vs média 14d)
      // Nota: com telemetria 15m e sem submeter applianceUsage real, isto é best-effort.
      const fpLabeled = inferred.updatedFingerprints.filter((fp) => fp.label);
      for (const fp of fpLabeled.slice(0, 2)) {
        const baseTitle = fp.label ? String(fp.label) : 'Equipamento';
        const msg = `${baseTitle}: monitorização ativa (fingerprint atualizado).`;
        const id = crypto.randomUUID();
        await cols.assistantNotifications.insertOne({
          id,
          customer_id: customerId,
          type: 'nilm_fingerprint_update',
          severity: 'info',
          title: 'NILM',
          message: msg,
          status: 'open',
          created_at: now
        });
        break;
      }
    }
  }

  tick().catch(() => null);
  const interval = setInterval(() => tick().catch(() => null), tickMs);
  interval.unref?.();
}
