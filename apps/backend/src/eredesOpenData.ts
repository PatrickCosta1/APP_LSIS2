type FetchOptions = {
  timeoutMs?: number;
};

const DEFAULT_BASE_URL = 'https://e-redes.opendatasoft.com';
const DEFAULT_TIMEOUT_MS = 12_000;

export type EredesDataset =
  | 'energia-injetada-na-rede-de-distribuicao'
  | 'consumo-total-nacional'
  | 'energia-produzida-total-nacional'
  | 'previsao-de-consumo'
  | 'cadastro_iluminacao_publica'
  | '3-consumos-faturados-por-municipio-ultimos-10-anos'
  | '02-consumos-faturados-por-codigo-postal-ultimos-5-anos';

export type EredesApiResponse = {
  total_count?: number;
  results?: any[];
  records?: any[];
};

function getBaseUrl() {
  return String(process.env.EREDES_OD_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

export function buildEredesUrl(pathOrUrl: string) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = getBaseUrl();
  const p = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${p}`;
}

async function fetchJson(url: string, opts: FetchOptions = {}): Promise<any> {
  const controller = new AbortController();
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json'
      }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`E-REDES Open Data HTTP ${res.status}: ${text.slice(0, 180)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchEredesRecords(dataset: EredesDataset, query: Record<string, string | number | undefined> = {}, opts: FetchOptions = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }

  const url = buildEredesUrl(`/api/explore/v2.1/catalog/datasets/${encodeURIComponent(dataset)}/records?${params.toString()}`);
  const json = (await fetchJson(url, opts)) as EredesApiResponse;
  const results = Array.isArray(json.results) ? json.results : Array.isArray(json.records) ? json.records : [];
  return { url, json, results };
}

export async function fetchLatestRecord(dataset: EredesDataset, opts: FetchOptions = {}) {
  // Quase todos os datasets têm `datahora`. Para datasets mensais, o default (sem order_by) pode não ser o mais recente;
  // aqui forçamos order_by quando faz sentido.
  const orderBy =
    dataset === 'cadastro_iluminacao_publica' ||
    dataset === '3-consumos-faturados-por-municipio-ultimos-10-anos' ||
    dataset === '02-consumos-faturados-por-codigo-postal-ultimos-5-anos'
      ? 'ano desc, mes desc'
      : 'datahora desc';

  const { results } = await fetchEredesRecords(
    dataset,
    {
      limit: 1,
      order_by: orderBy
    },
    opts
  );

  return (results[0] ?? null) as any;
}

export function asNumber(v: any) {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function computeRenewablesSharePct(inj: any) {
  const rede = asNumber(inj?.rede_dist);
  if (!rede || rede <= 0) return null;

  const eolica = asNumber(inj?.eolica) ?? 0;
  const fotovoltaica = asNumber(inj?.fotovoltaica) ?? 0;
  const hidrica = asNumber(inj?.hidrica) ?? 0;

  // Nota: “outras_tecnologias” pode incluir fontes não totalmente renováveis; por defeito não entra no rácio.
  const ren = eolica + fotovoltaica + hidrica;
  return Math.max(0, Math.min(100, (ren / rede) * 100));
}

export type NationalOpenDataContext = {
  lastUpdated: string | null;
  consumption: null | { ts: string | null; bt: number | null; mt: number | null; at: number | null; mat: number | null; total: number | null };
  production: null | { ts: string | null; dgm: number | null; pre: number | null; total: number | null };
  injection: null | {
    ts: string | null;
    redeDist: number | null;
    eolica: number | null;
    fotovoltaica: number | null;
    hidrica: number | null;
    renewablesSharePct: number | null;
  };
  forecast: null | { ts: string | null; bt: number | null; mt: number | null; at: number | null; mat: number | null; total: number | null };
};

function recordTsIso(r: any) {
  const ts = r?.datahora || r?.date || r?.data;
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function buildNationalContext(latest: {
  consumoTotalNacional?: any | null;
  energiaProduzidaTotalNacional?: any | null;
  energiaInjetadaRedeDistribuicao?: any | null;
  previsaoDeConsumo?: any | null;
}): NationalOpenDataContext {
  const cons = latest.consumoTotalNacional;
  const prod = latest.energiaProduzidaTotalNacional;
  const inj = latest.energiaInjetadaRedeDistribuicao;
  const prev = latest.previsaoDeConsumo;

  const consumption = cons
    ? {
        ts: recordTsIso(cons),
        bt: asNumber(cons.bt),
        mt: asNumber(cons.mt),
        at: asNumber(cons.at),
        mat: asNumber(cons.mat),
        total: asNumber(cons.total)
      }
    : null;

  const production = prod
    ? {
        ts: recordTsIso(prod),
        dgm: asNumber(prod.dgm),
        pre: asNumber(prod.pre),
        total: asNumber(prod.total)
      }
    : null;

  const injection = inj
    ? {
        ts: recordTsIso(inj),
        redeDist: asNumber(inj.rede_dist),
        eolica: asNumber(inj.eolica),
        fotovoltaica: asNumber(inj.fotovoltaica),
        hidrica: asNumber(inj.hidrica),
        renewablesSharePct: computeRenewablesSharePct(inj)
      }
    : null;

  const forecast = prev
    ? {
        ts: recordTsIso(prev),
        bt: asNumber(prev.bt),
        mt: asNumber(prev.mt),
        at: asNumber(prev.at),
        mat: asNumber(prev.mat),
        total: asNumber(prev.total)
      }
    : null;

  const candidates = [consumption?.ts, production?.ts, injection?.ts, forecast?.ts].filter(Boolean) as string[];
  const lastUpdated = candidates.length ? candidates.sort().slice(-1)[0] : null;

  return { lastUpdated, consumption, production, injection, forecast };
}
