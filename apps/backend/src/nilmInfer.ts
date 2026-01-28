export type Telemetry15mPoint = {
  ts: Date;
  watts: number;
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
  applianceId: number;
  startTs: Date;
  endTs: Date;
  energyWh: number;
  costEur: number;
  confidence: number;
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

type Block = {
  startTs: Date;
  endTs: Date;
  meanWatts: number;
  durationMin: number;
  energyWh: number;
};

function extractBlocks(points: Telemetry15mPoint[], baselineWatts: number, thresholdWatts: number): Block[] {
  const blocks: Block[] = [];
  let current: { startTs: Date; endTs: Date; sumW: number; n: number } | null = null;

  for (const p of points) {
    const residual = Math.max(0, p.watts - baselineWatts);
    const isOn = residual >= thresholdWatts;

    const endTs = new Date(p.ts.getTime() + 15 * 60 * 1000);

    if (isOn) {
      if (!current) current = { startTs: p.ts, endTs, sumW: 0, n: 0 };
      current.endTs = endTs;
      current.sumW += residual;
      current.n += 1;
    } else if (current) {
      const durationMin = current.n * 15;
      const meanWatts = current.n > 0 ? current.sumW / current.n : 0;
      const energyWh = current.sumW * 0.25; // watts * horas
      blocks.push({ startTs: current.startTs, endTs: current.endTs, meanWatts, durationMin, energyWh });
      current = null;
    }
  }

  if (current) {
    const durationMin = current.n * 15;
    const meanWatts = current.n > 0 ? current.sumW / current.n : 0;
    const energyWh = current.sumW * 0.25;
    blocks.push({ startTs: current.startTs, endTs: current.endTs, meanWatts, durationMin, energyWh });
  }

  return blocks;
}

function kmeans2D(samples: Array<[number, number]>, k: number, iters = 15) {
  if (samples.length === 0) return { centroids: [] as Array<[number, number]>, labels: [] as number[] };

  const kk = clamp(k, 1, Math.min(samples.length, 12));
  const centroids: Array<[number, number]> = [];
  for (let i = 0; i < kk; i += 1) centroids.push(samples[Math.floor(Math.random() * samples.length)]);

  const labels = new Array(samples.length).fill(0);

  for (let it = 0; it < iters; it += 1) {
    // assign
    for (let i = 0; i < samples.length; i += 1) {
      const [x, y] = samples[i];
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < kk; c += 1) {
        const [cx, cy] = centroids[c];
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      labels[i] = best;
    }

    // update
    const sum = Array.from({ length: kk }, () => [0, 0, 0] as [number, number, number]);
    for (let i = 0; i < samples.length; i += 1) {
      const c = labels[i];
      sum[c][0] += samples[i][0];
      sum[c][1] += samples[i][1];
      sum[c][2] += 1;
    }
    for (let c = 0; c < kk; c += 1) {
      const n = sum[c][2];
      if (n <= 0) continue;
      centroids[c] = [sum[c][0] / n, sum[c][1] / n];
    }
  }

  return { centroids, labels };
}

function labelFromSignature(meanWatts: number, durationMin: number) {
  const w = meanWatts;
  const d = durationMin;

  if (w >= 1200 && d <= 30) return { name: 'Pico rápido (chaleira/microondas)', category: 'Cozinha' };
  if (w >= 700 && d >= 45 && d <= 180) return { name: 'Aquecimento de água (termo)', category: 'Água quente' };
  if (w >= 350 && w <= 950 && d >= 60) return { name: 'Ciclo longo (lavagem)', category: 'Lavandaria' };
  if (w >= 200 && w <= 1200 && d >= 120) return { name: 'Climatização (AC/aquecimento)', category: 'Climatização' };
  if (w >= 60 && w <= 220 && d <= 60) return { name: 'Ciclo curto (frigorífico)', category: 'Cozinha' };

  return { name: 'Equipamento (inferido)', category: null };
}

export function inferAppliancesFromAggregate(opts: {
  points: Telemetry15mPoint[];
  priceEurPerKwh: number;
  maxAppliances?: number;
}): { appliances: InferredAppliance[]; sessions: InferredSession[] } {
  const points = (opts.points ?? []).filter((p) => p.ts instanceof Date && Number.isFinite(p.watts));
  if (points.length < 4) {
    // Muito poucos pontos: devolve só base
    const baseKwh = points.reduce((acc, p) => acc + Math.max(0, p.watts) / 1000 * 0.25, 0);
    const baseCost = baseKwh * opts.priceEurPerKwh;
    return {
      appliances: [
        {
          id: 1,
          name: 'Consumo base (stand-by)',
          category: 'Base',
          costEur: Number(baseCost.toFixed(2)),
          energyKwh: Number(baseKwh.toFixed(2)),
          sessions: 1,
          confidence: 0.5
        }
      ],
      sessions: []
    };
  }

  const wattsSeries = points.map((p) => p.watts);
  const baseline = clamp(quantile(wattsSeries, 0.1), 0, quantile(wattsSeries, 0.5));

  // limiar dinâmico para captar variações em consumos baixos/medios
  const threshold = clamp(baseline * 0.4 + 80, 40, 300);
  const blocks = extractBlocks(points, baseline, threshold);
  if (!blocks.length) {
    // só stand-by
    const kwh = (baseline / 1000) * 0.25 * points.length;
    const cost = kwh * opts.priceEurPerKwh;
    return {
      appliances: [
        {
          id: 1,
          name: 'Consumo base (stand-by)',
          category: 'Base',
          costEur: Number(cost.toFixed(2)),
          energyKwh: Number(kwh.toFixed(2)),
          sessions: 1,
          confidence: 0.6
        }
      ],
      sessions: []
    };
  }

  const features = blocks.map((b) => [Math.log1p(b.meanWatts), Math.log1p(b.durationMin)] as [number, number]);
  const k = clamp(Math.round(Math.sqrt(blocks.length / 2)), 2, opts.maxAppliances ?? 6);
  const { centroids, labels } = kmeans2D(features, k);

  const clusterStats = new Map<number, { blocks: Block[]; meanWatts: number; durationMin: number }>();
  for (let i = 0; i < blocks.length; i += 1) {
    const c = labels[i] ?? 0;
    const arr = clusterStats.get(c)?.blocks ?? [];
    arr.push(blocks[i]);
    clusterStats.set(c, { blocks: arr, meanWatts: 0, durationMin: 0 });
  }

  // compute cluster representative values from centroid (undo log1p)
  for (let c = 0; c < centroids.length; c += 1) {
    const centroid = centroids[c];
    const st = clusterStats.get(c);
    if (!st) continue;
    st.meanWatts = Math.expm1(centroid[0]);
    st.durationMin = Math.expm1(centroid[1]);
  }

  const sessions: InferredSession[] = [];
  const appliancesById = new Map<
    number,
    { id: number; name: string; category: string | null; costEur: number; energyKwh: number; sessions: number; confidence: number }
  >();

  for (const [clusterId, st] of clusterStats.entries()) {
    const meanWatts = st.meanWatts;
    const durationMin = st.durationMin;
    const label = labelFromSignature(meanWatts, durationMin);

    // ID estável: baseado no rótulo (nome+categoria), evitando 404 quando o k-means muda ligeiramente
    // entre janelas (7d vs 30d) ou execuções.
    const labelKey = `${label.name}|${label.category ?? ''}`;
    const id = (hash32(labelKey) % 900000) + 1000;

    let totalWh = 0;
    for (const b of st.blocks) {
      totalWh += b.energyWh;
      const cost = (b.energyWh / 1000) * opts.priceEurPerKwh;
      sessions.push({
        applianceId: id,
        startTs: b.startTs,
        endTs: b.endTs,
        energyWh: Number(b.energyWh.toFixed(3)),
        costEur: Number(cost.toFixed(6)),
        confidence: Number(clamp(0.65 + st.blocks.length / 40, 0.65, 0.92).toFixed(2))
      });
    }

    const kwh = totalWh / 1000;
    const costEur = kwh * opts.priceEurPerKwh;

    const prev = appliancesById.get(id);
    const conf = Number(clamp(0.65 + st.blocks.length / 40, 0.65, 0.92).toFixed(2));
    if (!prev) {
      appliancesById.set(id, {
        id,
        name: label.name,
        category: label.category,
        costEur: Number(costEur.toFixed(2)),
        energyKwh: Number(kwh.toFixed(2)),
        sessions: st.blocks.length,
        confidence: conf
      });
    } else {
      appliancesById.set(id, {
        id,
        name: prev.name,
        category: prev.category,
        costEur: Number((prev.costEur + costEur).toFixed(2)),
        energyKwh: Number((prev.energyKwh + kwh).toFixed(2)),
        sessions: prev.sessions + st.blocks.length,
        confidence: Number(Math.max(prev.confidence, conf).toFixed(2))
      });
    }
  }

  // Stand-by como categoria base (energia ~ baseline)
  const baseKwh = (baseline / 1000) * 0.25 * points.length;
  const baseCost = baseKwh * opts.priceEurPerKwh;
  appliancesById.set(1, {
    id: 1,
    name: 'Consumo base (stand-by)',
    category: 'Base',
    costEur: Number(baseCost.toFixed(2)),
    energyKwh: Number(baseKwh.toFixed(2)),
    sessions: 1,
    confidence: 0.7
  });

  const appliances = Array.from(appliancesById.values());
  appliances.sort((a, b) => b.costEur - a.costEur);
  return { appliances: appliances.slice(0, (opts.maxAppliances ?? 6) + 1), sessions };
}
