type IpmaCity = {
  globalIdLocal: number;
  local: string;
};

type IpmaCitiesResponse = {
  data: IpmaCity[];
};

export type IpmaForecastDay = {
  forecastDate: string; // YYYY-MM-DD
  tMin?: string;
  tMax?: string;
  idWeatherType?: number;
  precipitaProb?: string;
};

export type IpmaDailyForecastResponse = {
  data: IpmaForecastDay[];
  globalIdLocal: number;
  dataUpdate?: string;
};

const IPMA_CITIES_URL = 'https://api.ipma.pt/open-data/distrits-islands.json';

const cityCache: { expiresAt: number; data: IpmaCity[] | null } = { expiresAt: 0, data: null };
const forecastCache = new Map<number, { expiresAt: number; data: IpmaDailyForecastResponse }>();

const DEFAULT_GLOBAL_ID_LOCAL = 1131200; // Porto

function normalizeText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

async function fetchJson<T>(url: string, timeoutMs = 4000): Promise<T> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(id);
  }
}

async function getIpmaCities(): Promise<IpmaCity[] | null> {
  const now = Date.now();
  if (cityCache.data && cityCache.expiresAt > now) return cityCache.data;

  try {
    const json = await fetchJson<IpmaCitiesResponse>(IPMA_CITIES_URL, 5000);
    const items = Array.isArray(json?.data) ? json.data : [];
    const normalized = items
      .map((c) => ({ globalIdLocal: Number(c.globalIdLocal), local: String(c.local ?? '') }))
      .filter((c) => Number.isFinite(c.globalIdLocal) && c.globalIdLocal > 0 && c.local);

    cityCache.data = normalized;
    cityCache.expiresAt = now + 24 * 60 * 60 * 1000; // 24h
    return normalized;
  } catch {
    // sem rede / IPMA down
    cityCache.data = null;
    cityCache.expiresAt = now + 10 * 60 * 1000; // tenta novamente em 10 min
    return null;
  }
}

export async function resolveIpmaGlobalIdLocal(city: string | undefined | null): Promise<number> {
  if (!city) return DEFAULT_GLOBAL_ID_LOCAL;

  const cities = await getIpmaCities();
  if (!cities?.length) return DEFAULT_GLOBAL_ID_LOCAL;

  const needle = normalizeText(city);

  // match exato
  const exact = cities.find((c) => normalizeText(c.local) === needle);
  if (exact) return exact.globalIdLocal;

  // match "contém" (ex.: "Vila Nova de Gaia" vs "Gaia")
  const partial = cities.find((c) => {
    const hay = normalizeText(c.local);
    return hay.includes(needle) || needle.includes(hay);
  });
  if (partial) return partial.globalIdLocal;

  return DEFAULT_GLOBAL_ID_LOCAL;
}

export async function getIpmaDailyForecast(globalIdLocal: number): Promise<IpmaDailyForecastResponse | null> {
  const now = Date.now();
  const cached = forecastCache.get(globalIdLocal);
  if (cached && cached.expiresAt > now) return cached.data;

  const url = `https://api.ipma.pt/open-data/forecast/meteorology/cities/daily/${globalIdLocal}.json`;

  try {
    const json = await fetchJson<IpmaDailyForecastResponse>(url, 5000);
    if (!json?.data || !Array.isArray(json.data)) return null;

    forecastCache.set(globalIdLocal, { expiresAt: now + 30 * 60 * 1000, data: json }); // 30 min
    return json;
  } catch {
    return null;
  }
}

function parseMaybeNumber(s: string | undefined): number | null {
  if (typeof s !== 'string') return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function getDayForecast(forecast: IpmaDailyForecastResponse, ymd: string): IpmaForecastDay | null {
  const day = forecast.data?.find((d) => d?.forecastDate === ymd);
  return day ?? null;
}

function addDaysYmd(ymd: string, addDays: number): string | null {
  // ymd = YYYY-MM-DD
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + addDays);
  return dt.toISOString().slice(0, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cosineEase01(x01: number): number {
  const x = clamp(x01, 0, 1);
  return (1 - Math.cos(Math.PI * x)) / 2;
}

function tempCurveMinutes(
  minutesOfDay: number,
  tMin: number | null,
  tMax: number | null,
  tMinNextDay: number | null
): number | null {
  if (tMin == null && tMax == null) return null;
  if (tMin == null) return tMax;
  if (tMax == null) return tMin;

  const MIN_TIME = 6 * 60; // 06:00
  const MAX_TIME = 15 * 60; // 15:00
  const mins = ((minutesOfDay % (24 * 60)) + 24 * 60) % (24 * 60);

  if (mins >= MIN_TIME && mins <= MAX_TIME) {
    const x01 = (mins - MIN_TIME) / (MAX_TIME - MIN_TIME);
    const k = cosineEase01(x01);
    return tMin + (tMax - tMin) * k;
  }

  // segmento de descida: 15:00 -> dia seguinte 06:00
  const nextMin = tMinNextDay != null ? tMinNextDay : tMin;
  const DESC_DURATION = (24 * 60 - MAX_TIME) + MIN_TIME;
  const minsExt = mins < MIN_TIME ? mins + 24 * 60 : mins;
  const x01 = (minsExt - MAX_TIME) / DESC_DURATION;
  const k = cosineEase01(x01);
  return tMax + (nextMin - tMax) * k;
}

export function getIpmaAvgTempForDate(forecast: IpmaDailyForecastResponse, ymd: string): number | null {
  const day = getDayForecast(forecast, ymd);
  if (!day) return null;

  const tMin = parseMaybeNumber(day.tMin);
  const tMax = parseMaybeNumber(day.tMax);

  if (tMin != null && tMax != null) return (tMin + tMax) / 2;
  if (tMax != null) return tMax;
  if (tMin != null) return tMin;

  return null;
}

// Curva horária (local) baseada em tMin/tMax diários:
// - assume tMin ~ 06:00 e tMax ~ 15:00
// - transição suave (cosine easing)
// - se existir tMin do dia seguinte, a descida 15:00->06:00 converge para esse valor
export function getIpmaTempForLocalDateTime(
  forecast: IpmaDailyForecastResponse,
  ymdLocal: string,
  minutesOfDayLocal: number
): number | null {
  const day = getDayForecast(forecast, ymdLocal);
  if (!day) return null;

  const tMin = parseMaybeNumber(day.tMin);
  const tMax = parseMaybeNumber(day.tMax);

  const nextYmd = addDaysYmd(ymdLocal, 1);
  const nextDay = nextYmd ? getDayForecast(forecast, nextYmd) : null;
  const tMinNext = nextDay ? parseMaybeNumber(nextDay.tMin) : null;

  return tempCurveMinutes(minutesOfDayLocal, tMin, tMax, tMinNext);
}
