import crypto from 'node:crypto';

export type Telemetry15mPoint = {
  ts: Date;
  watts: number;
};

export type NilmSessionFeatures = {
  startTs: Date;
  endTs: Date;
  durationMin: number;
  meanWatts: number;
  peakWatts: number;
  energyWh: number;

  // Proxy de “inrush” com base em amostras 15m (não capta picos de segundos)
  startStepWatts: number;

  // Sazonalidade/padrões
  startHour: number; // 0-23 UTC
  startDow: number; // 0=Mon .. 6=Sun
};

export type CustomerNilmSessionDoc = {
  id: string;
  customer_id: string;
  start_ts: Date;
  end_ts: Date;
  features: {
    duration_min: number;
    mean_watts: number;
    peak_watts: number;
    energy_wh: number;
    start_step_watts: number;
    start_hour_utc: number;
    start_dow: number;
  };
  fingerprint_id: string | null;
  inferred_name: string;
  inferred_category: string | null;
  confidence: number;
  label: string | null; // validação do utilizador
  created_at: Date;
  updated_at: Date;
};

export type CustomerNilmFingerprintDoc = {
  id: string; // fingerprint_id
  customer_id: string;

  // centroid/mediana robusta
  mean_watts: number;
  duration_min: number;
  peak_watts: number;
  start_step_watts: number;

  // comportamento (duty-cycle proxies)
  sessions: number;
  avg_sessions_per_day: number;

  // rótulo “aprendido”
  label: string | null;
  category: string | null;
  label_confidence: number; // 0..1

  updated_at: Date;
  created_at: Date;
};

export type InferredAppliance = {
  id: number;
  name: string;
  category: string | null;
  costEur: number;
  energyKwh: number;
  sessions: number;
  confidence: number;
};

export type InferredSession = {
  sessionId: string;
  applianceId: number;
  fingerprintId: string;
  startTs: Date;
  endTs: Date;
  durationMin: number;
  meanWatts: number;
  peakWatts: number;
  startStepWatts: number;
  energyWh: number;
  costEur: number;
  confidence: number;
  inferredLabel: string;
  userLabel: string | null;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
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

function quantile(values: number[], q: number) {
  if (!values.length) return 0;
  const xs = [...values].sort((a, b) => a - b);
  const pos = (xs.length - 1) * clamp(q, 0, 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = xs[base] ?? xs[0];
  const b = xs[base + 1] ?? a;
  return a + rest * (b - a);
}

function toDayKeyUtc(d: Date) {
  return d.toISOString().slice(0, 10);
}

function dowMon0(d: Date) {
  return (d.getUTCDay() + 6) % 7;
}

function stableSessionId(customerId: string, startTs: Date, endTs: Date, meanWatts: number, durationMin: number) {
  const raw = `${customerId}|${startTs.toISOString()}|${endTs.toISOString()}|${Math.round(meanWatts)}|${Math.round(durationMin)}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

function distanceScore(a: { meanWatts: number; durationMin: number; startStepWatts: number; peakWatts: number }, b: { meanWatts: number; durationMin: number; startStepWatts: number; peakWatts: number }) {
  // escala logarítmica para robustez
  const dx = Math.log1p(a.meanWatts) - Math.log1p(b.meanWatts);
  const dy = Math.log1p(a.durationMin) - Math.log1p(b.durationMin);
  const dz = Math.log1p(a.startStepWatts) - Math.log1p(b.startStepWatts);
  const dp = Math.log1p(a.peakWatts) - Math.log1p(b.peakWatts);
  const d2 = dx * dx + dy * dy + 0.6 * dz * dz + 0.6 * dp * dp;
  const score = Math.exp(-0.9 * d2);
  return clamp(score, 0, 1);
}

function labelFromHeuristics(f: { meanWatts: number; durationMin: number; startStepWatts: number; peakWatts: number }) {
  const w = f.meanWatts;
  const d = f.durationMin;
  const step = f.startStepWatts;
  const peak = f.peakWatts;

  // Nota: com 15m, “inrush” é apenas um degrau de potência.
  if (peak >= 1400 && d <= 30) return { name: 'Microondas', category: 'Cozinha' };
  if ((w >= 700 && d >= 45 && d <= 240) || (peak >= 1100 && d >= 45)) return { name: 'Aquecimento de água', category: 'Água quente' };
  if (w >= 350 && w <= 1000 && d >= 60 && d <= 240) return { name: 'Máquina de lavar/loiça', category: 'Lavandaria' };
  if (w >= 200 && w <= 1600 && d >= 120) return { name: 'Climatização', category: 'Climatização' };

  // Frigorífico tende a ciclos curtos e repetidos (aqui: baixo consumo + degrau pequeno)
  if (w >= 60 && w <= 250 && d <= 75 && step <= 220) return { name: 'Frigorífico', category: 'Cozinha' };

  return { name: 'Equipamento (inferido)', category: null };
}

export function extractNilmSessions15m(points: Telemetry15mPoint[]) {
  const pts = (points ?? [])
    .filter((p) => p.ts instanceof Date && Number.isFinite(p.watts))
    .slice()
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());

  if (pts.length < 4) return { baselineWatts: 0, thresholdWatts: 0, sessions: [] as NilmSessionFeatures[] };

  const wattsSeries = pts.map((p) => p.watts);
  const baselineWatts = clamp(quantile(wattsSeries, 0.1), 0, quantile(wattsSeries, 0.5));

  // threshold dinâmico (mantém sensível a consumos baixos)
  const thresholdWatts = clamp(baselineWatts * 0.4 + 80, 40, 320);

  const sessions: NilmSessionFeatures[] = [];
  let current: null | {
    startTs: Date;
    endTs: Date;
    sumW: number;
    n: number;
    peakW: number;
    startResidual: number;
    startPrevResidual: number;
  } = null;

  let prevResidual = 0;

  for (const p of pts) {
    const residual = Math.max(0, p.watts - baselineWatts);
    const isOn = residual >= thresholdWatts;
    const endTs = new Date(p.ts.getTime() + 15 * 60 * 1000);

    if (isOn) {
      if (!current) {
        current = {
          startTs: p.ts,
          endTs,
          sumW: 0,
          n: 0,
          peakW: 0,
          startResidual: residual,
          startPrevResidual: prevResidual
        };
      }
      current.endTs = endTs;
      current.sumW += residual;
      current.n += 1;
      current.peakW = Math.max(current.peakW, residual);
    } else if (current) {
      const durationMin = current.n * 15;
      const meanWatts = current.n > 0 ? current.sumW / current.n : 0;
      const energyWh = current.sumW * 0.25;
      const startStepWatts = Math.max(0, current.startResidual - current.startPrevResidual);
      const startHour = current.startTs.getUTCHours();
      const startDow = dowMon0(current.startTs);

      sessions.push({
        startTs: current.startTs,
        endTs: current.endTs,
        durationMin,
        meanWatts,
        peakWatts: current.peakW,
        energyWh,
        startStepWatts,
        startHour,
        startDow
      });
      current = null;
    }

    prevResidual = residual;
  }

  if (current) {
    const durationMin = current.n * 15;
    const meanWatts = current.n > 0 ? current.sumW / current.n : 0;
    const energyWh = current.sumW * 0.25;
    const startStepWatts = Math.max(0, current.startResidual - current.startPrevResidual);
    const startHour = current.startTs.getUTCHours();
    const startDow = dowMon0(current.startTs);

    sessions.push({
      startTs: current.startTs,
      endTs: current.endTs,
      durationMin,
      meanWatts,
      peakWatts: current.peakW,
      energyWh,
      startStepWatts,
      startHour,
      startDow
    });
  }

  return { baselineWatts, thresholdWatts, sessions };
}

export function summarizeDutyCycleByDay(sessions: NilmSessionFeatures[]) {
  const byDay = new Map<string, number>();
  for (const s of sessions) {
    const k = toDayKeyUtc(s.startTs);
    byDay.set(k, (byDay.get(k) ?? 0) + 1);
  }
  const days = Math.max(1, byDay.size);
  const total = Array.from(byDay.values()).reduce((a, b) => a + b, 0);
  return { sessionsPerDay: total / days };
}

export function makeFingerprintId(customerId: string, centroid: { meanWatts: number; durationMin: number; startStepWatts: number; peakWatts: number }) {
  const key = `${customerId}|${Math.round(centroid.meanWatts)}|${Math.round(centroid.durationMin)}|${Math.round(centroid.startStepWatts)}|${Math.round(centroid.peakWatts)}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

export function numericApplianceId(customerId: string, fingerprintId: string) {
  const key = `${customerId}|${fingerprintId}`;
  return (hash32(key) % 900000) + 1000;
}

function stripLabelSuffix(label: string) {
  // Remove sufixos do tipo " (abcd)" adicionados para debug/uniqueness.
  return String(label ?? '')
    .replace(/\s*\([^)]{1,32}\)\s*$/u, '')
    .trim();
}

function typeKeyFromLabel(label: string) {
  const base = stripLabelSuffix(label);
  // normaliza acentos e cria um slug estável
  const deaccent = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const slug = deaccent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'equipamento';
}

export function numericApplianceTypeId(customerId: string, typeKey: string) {
  const key = `${customerId}|type|${typeKey}`;
  // Mantém intervalo parecido com numericApplianceId, mas garante que nunca é 1.
  return (hash32(key) % 900000) + 1000;
}

export function inferFromFingerprints(opts: {
  customerId: string;
  sessions: NilmSessionFeatures[];
  priceEurPerKwh: number;
  knownFingerprints: CustomerNilmFingerprintDoc[];
  maxAppliances?: number;
  userLabelsBySessionId?: Map<string, string | null>;
  baselineKwh?: number;
}): { appliances: InferredAppliance[]; sessions: InferredSession[]; updatedFingerprints: CustomerNilmFingerprintDoc[] } {
  const maxAppliances = clamp(opts.maxAppliances ?? 6, 2, 12);
  const known = opts.knownFingerprints ?? [];

  // match sessão -> fingerprint mais próximo (se existir) ou cria fingerprint novo (online clustering)
  const updated = new Map<string, CustomerNilmFingerprintDoc>();
  const sessionsOut: InferredSession[] = [];

  for (const s of opts.sessions) {
    const candidates = [...updated.values(), ...known];
    const nearest = candidates
      .map((fp) => ({
        fp,
        score: distanceScore(
          { meanWatts: s.meanWatts, durationMin: s.durationMin, startStepWatts: s.startStepWatts, peakWatts: s.peakWatts },
          { meanWatts: fp.mean_watts, durationMin: fp.duration_min, startStepWatts: fp.start_step_watts, peakWatts: fp.peak_watts }
        )
      }))
      .sort((a, b) => b.score - a.score)[0];

    let fp: CustomerNilmFingerprintDoc | null = null;
    let matchScore = nearest?.score ?? 0;

    if (nearest && matchScore >= 0.55) {
      fp = updated.get(nearest.fp.id) ?? { ...nearest.fp };
    } else {
      // cria novo fingerprint
      const centroid = { meanWatts: s.meanWatts, durationMin: s.durationMin, startStepWatts: s.startStepWatts, peakWatts: s.peakWatts };
      const id = makeFingerprintId(opts.customerId, centroid);
      fp =
        updated.get(id) ??
        ({
          id,
          customer_id: opts.customerId,
          mean_watts: centroid.meanWatts,
          duration_min: centroid.durationMin,
          peak_watts: centroid.peakWatts,
          start_step_watts: centroid.startStepWatts,
          sessions: 0,
          avg_sessions_per_day: 0,
          label: null,
          category: null,
          label_confidence: 0,
          created_at: new Date(),
          updated_at: new Date()
        } as CustomerNilmFingerprintDoc);
      matchScore = 0.45;
    }

    // Atualiza centroid com EMA leve
    const alpha = clamp(1 / Math.max(8, fp.sessions + 1), 0.06, 0.22);
    fp.mean_watts = fp.mean_watts * (1 - alpha) + s.meanWatts * alpha;
    fp.duration_min = fp.duration_min * (1 - alpha) + s.durationMin * alpha;
    fp.peak_watts = fp.peak_watts * (1 - alpha) + s.peakWatts * alpha;
    fp.start_step_watts = fp.start_step_watts * (1 - alpha) + s.startStepWatts * alpha;
    fp.sessions += 1;
    fp.updated_at = new Date();

    updated.set(fp.id, fp);

    const sessionId = stableSessionId(opts.customerId, s.startTs, s.endTs, s.meanWatts, s.durationMin);
    const rawUserLabel = opts.userLabelsBySessionId?.get(sessionId) ?? null;
    const userLabel = typeof rawUserLabel === 'string' ? rawUserLabel.trim() : null;

    // Feedback loop: um rótulo confirmado numa sessão ajusta o fingerprint (aprendizagem por cliente).
    if (userLabel) {
      if (!fp.label) {
        fp.label = userLabel;
        fp.label_confidence = clamp(Math.max(fp.label_confidence, 0.6), 0, 1);
      } else if (fp.label === userLabel) {
        fp.label_confidence = clamp(fp.label_confidence + 0.08, 0, 1);
      } else {
        fp.label_confidence = clamp(fp.label_confidence - 0.12, 0, 1);
      }
    }

    const rawLabel = fp.label ?? userLabel ?? labelFromHeuristics(s).name;
    const category = fp.category ?? (fp.label ? fp.category : labelFromHeuristics(s).category);

    // Para o utilizador/UI queremos 1 item por "tipo". Então:
    // - o nome exibido é o label base (sem sufixo)
    // - o applianceId é derivado do tipo (não do fingerprint)
    const baseLabel = stripLabelSuffix(rawLabel);
    const typeKey = typeKeyFromLabel(baseLabel);
    const applianceId = numericApplianceTypeId(opts.customerId, typeKey);
    const cost = (s.energyWh / 1000) * opts.priceEurPerKwh;

    const conf = clamp(0.5 + 0.35 * matchScore + Math.min(0.12, fp.sessions / 120), 0.45, 0.95);

    sessionsOut.push({
      sessionId,
      applianceId,
      fingerprintId: fp.id,
      startTs: s.startTs,
      endTs: s.endTs,
      durationMin: s.durationMin,
      meanWatts: Number(s.meanWatts.toFixed(2)),
      peakWatts: Number(s.peakWatts.toFixed(2)),
      startStepWatts: Number(s.startStepWatts.toFixed(2)),
      energyWh: Number(s.energyWh.toFixed(3)),
      costEur: Number(cost.toFixed(6)),
      confidence: Number(conf.toFixed(2)),
      inferredLabel: baseLabel,
      userLabel
    });
  }

  // duty-cycle proxy por fingerprint (usa sessões atuais; em worker será melhor)
  const updatedFingerprints = Array.from(updated.values()).map((fp) => {
    const mine = opts.sessions.filter((s) => {
      const score = distanceScore(
        { meanWatts: s.meanWatts, durationMin: s.durationMin, startStepWatts: s.startStepWatts, peakWatts: s.peakWatts },
        { meanWatts: fp.mean_watts, durationMin: fp.duration_min, startStepWatts: fp.start_step_watts, peakWatts: fp.peak_watts }
      );
      return score >= 0.55;
    });
    fp.avg_sessions_per_day = summarizeDutyCycleByDay(mine).sessionsPerDay;
    return fp;
  });

  // Agrega por applianceId
  const byApp = new Map<number, InferredAppliance>();
  for (const s of sessionsOut) {
    const prev = byApp.get(s.applianceId);
    const kwh = s.energyWh / 1000;
    const cost = s.costEur;
    if (!prev) {
      const inferred = labelFromHeuristics({ meanWatts: s.meanWatts, durationMin: s.durationMin, startStepWatts: s.startStepWatts, peakWatts: s.peakWatts });
      byApp.set(s.applianceId, {
        id: s.applianceId,
        name: s.inferredLabel,
        category: inferred.category,
        costEur: Number(cost.toFixed(2)),
        energyKwh: Number(kwh.toFixed(2)),
        sessions: 1,
        confidence: s.confidence
      });
    } else {
      byApp.set(s.applianceId, {
        ...prev,
        costEur: Number((prev.costEur + cost).toFixed(2)),
        energyKwh: Number((prev.energyKwh + kwh).toFixed(2)),
        sessions: prev.sessions + 1,
        confidence: Number(Math.max(prev.confidence, s.confidence).toFixed(2))
      });
    }
  }

  // Stand-by como base
  const baseKwh = typeof opts.baselineKwh === 'number' && Number.isFinite(opts.baselineKwh) ? Math.max(0, opts.baselineKwh) : 0;
  byApp.set(1, {
    id: 1,
    name: 'Consumo base (stand-by)',
    category: 'Base',
    costEur: Number((baseKwh * opts.priceEurPerKwh).toFixed(2)),
    energyKwh: Number(baseKwh.toFixed(2)),
    sessions: 1,
    confidence: 0.7
  });

  const appliances = Array.from(byApp.values())
    .sort((a, b) => b.costEur - a.costEur)
    .slice(0, maxAppliances + 1);

  return { appliances, sessions: sessionsOut, updatedFingerprints };
}
