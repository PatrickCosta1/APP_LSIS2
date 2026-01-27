import React, { useEffect, useMemo, useRef, useState } from 'react';
import logoImg from '../assets/images/logo.png';
import AssistantChatModal from '../components/AssistantChatModal';
import SettingsDrawer from '../components/SettingsDrawer';
import './Dashboard.css';
import './Charts.css';

type RangeKey = 'dia' | 'semana' | 'mes';

function toUtcDayKey(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayUtcDayKey() {
  return toUtcDayKey(new Date());
}

type ConsumptionSeriesResponse = {
  range: RangeKey;
  labels: string[];
  values: number[];
  lastUpdated: string;
  // opcionais (range=dia -> date, range=semana -> days)
  date?: string;
  days?: number;
  // opcionais (modo personalizado)
  from?: string;
  to?: string;
  granularity?: '15m' | '1h' | '1d';
};

function toLocalInputValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

function toIsoOrNullFromLocalInput(v: string) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

type PowerSuggestionResponse = {
  customerId: string;
  lastUpdated: string;
  contractedKva: number;
  yearlyPeakKva: number;
  suggestedIdealKva: number;
  usagePctOfContracted: number;
  status: 'sobredimensionado' | 'subdimensionado' | 'ok';
  title: string;
  message: string;
  modelUsed: 'ai' | 'heuristic';
  riskExceedPct?: number;
  savingsMonth?: number;
  alternatives?: Array<{ kva: number; riskExceedPct: number; powerFeeMonth: number; score: number }>;
};

type HourlyEfficiencyResponse = {
  customerId: string;
  lastUpdated: string;
  days: number;
  scorePct: number;
  title: string;
  note: string;
  estimatedSavingsMonthEur: number;
  bestHoursUtc: number[];
  peakHoursUtc: number[];
  avgKwhByHourUtc: number[];
  forecastNext24hKwhByHourUtc: number[] | null;
};

type ElectricalHealthResponse = {
  customerId: string;
  lastUpdated: string;
  status: 'ok' | 'atencao' | 'risco';
  healthPct: number;
  contractedPowerKva: number;
  powerInUseKva: number;
  warning: string | null;
};

type ContractAnalysisResponse = {
  customerId: string;
  lastUpdated: string;
  forecastMonthKwh: number;
  offpeakPct: number;
  current: {
    utility: string;
    tariff: string;
    price_vazio_eur_per_kwh: number;
    price_cheia_eur_per_kwh: number;
    fixed_daily_fee_eur: number;
    estimatedMonth: { energy: number; power: number; total: number; offpeakPct: number };
  };
  suggestion: {
    tariff: string;
    message: string;
    compare: {
      simples: { rates: { vazio: number; cheia: number }; estimatedMonth: { energy: number; power: number; total: number; offpeakPct: number } };
      bihorario: { rates: { vazio: number; cheia: number }; estimatedMonth: { energy: number; power: number; total: number; offpeakPct: number } };
    };
  };
};

type MarketOffersResponse = {
  customerId: string;
  lastUpdated: string;
  currentMonthEur: number;
  best: null | {
    provider: string;
    name: string;
    tariff: string;
    price_vazio_eur_per_kwh: number;
    price_cheia_eur_per_kwh: number;
    fixed_daily_fee_eur: number;
    estimatedMonthEur: number;
    savingsMonthEur: number;
    savingsYearEur: number;
    why: string;
  };
  offers: Array<{
    provider: string;
    name: string;
    tariff: string;
    price_vazio_eur_per_kwh: number;
    price_cheia_eur_per_kwh: number;
    fixed_daily_fee_eur: number;
    estimatedMonthEur: number;
    savingsMonthEur: number;
    savingsYearEur: number;
    why: string;
  }>;
};

type InsightsResponse = {
  customerId: string;
  lastUpdated: string;
  tips: Array<{ id: string; icon: string; text: string }>;
};

type ContractSimRequest = {
  tariff: string;
  price_vazio_eur_per_kwh: number;
  price_cheia_eur_per_kwh: number;
  fixed_daily_fee_eur: number;
};

type ContractSimResponse = {
  customerId: string;
  lastUpdated: string;
  forecastMonthKwh: number;
  offpeakPct: number;
  current: { tariff: string; rates: { vazio: number; cheia: number }; fixed_daily_fee_eur: number; energy: number; power: number; total: number };
  proposed: { tariff: string; rates: { vazio: number; cheia: number }; fixed_daily_fee_eur: number; energy: number; power: number; total: number };
  savingsMonthEur: number;
};

const navItems = [
  {
    key: 'home',
    label: 'Home',
    href: '/dashboard',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path
          d="M3 9L12 2L21 9V20a2 2 0 0 1-2 2h-5a1 1 0 0 1-1-1v-6H11v6a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V9Z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    key: 'stats',
    label: 'Estatísticas',
    href: '/graficos',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 21V10M12 21V3M19 21v-8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'devices',
    label: 'Dispositivos',
    href: '/equipamentos',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8" />
        <path d="M12 16v4" />
      </svg>
    ),
  },
  {
    key: 'security',
    label: 'Segurança',
    href: '/seguranca',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2L5 6v6c0 5 3.5 9.5 7 10 3.5-0.5 7-5 7-10V6l-7-4z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
] as const;

function buildLinePath(values: number[], width: number, height: number) {
  const paddingX = 14;
  const paddingY = 14;
  const w = Math.max(1, width - paddingX * 2);
  const h = Math.max(1, height - paddingY * 2);

  const safe = values.length ? values : [0];
  const max = Math.max(...safe);
  const min = Math.min(...safe);
  const range = Math.max(1e-9, max - min);

  const pts = safe.map((v, i) => {
    const x = paddingX + (i / Math.max(1, safe.length - 1)) * w;
    const y = paddingY + (1 - (v - min) / range) * h;
    return { x, y };
  });

  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
  return { d, pts, min, max };
}

function formatPtDateTime(iso: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(d);
}

type AnalyticsRangeMode = 'dia' | 'semana' | 'mes' | 'periodo';

function Charts() {
  const [rangeMode, setRangeMode] = useState<AnalyticsRangeMode>('dia');
  const [selectedDay, setSelectedDay] = useState<string>(() => todayUtcDayKey());
  const [weekDays, setWeekDays] = useState<number>(7);
  const [periodFromLocal, setPeriodFromLocal] = useState<string>(() => {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return toLocalInputValue(start);
  });
  const [periodToLocal, setPeriodToLocal] = useState<string>(() => toLocalInputValue(new Date()));
  const [periodGranularity, setPeriodGranularity] = useState<'15m' | '1h' | '1d'>('15m');

  const range = (rangeMode === 'periodo' ? 'dia' : rangeMode) as RangeKey;
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement | null>(null);

  const [assistantOpen, setAssistantOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customerName, setCustomerName] = useState<string>('Cliente');
  const [userEmail, setUserEmail] = useState<string>('');
  const [userPhotoUrl, setUserPhotoUrl] = useState<string | null>(null);

  const [apiBase, setApiBase] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [series, setSeries] = useState<ConsumptionSeriesResponse>({ range: 'semana', labels: [], values: [], lastUpdated: '' });

  const [power, setPower] = useState<PowerSuggestionResponse | null>(null);
  const [powerModalOpen, setPowerModalOpen] = useState(false);

  const [eff, setEff] = useState<HourlyEfficiencyResponse | null>(null);
  const [elec, setElec] = useState<ElectricalHealthResponse | null>(null);

  const [contract, setContract] = useState<ContractAnalysisResponse | null>(null);
  const [offers, setOffers] = useState<MarketOffersResponse | null>(null);
  const [insights, setInsights] = useState<InsightsResponse | null>(null);

  const [priceModalOpen, setPriceModalOpen] = useState(false);
  const [offersModalOpen, setOffersModalOpen] = useState(false);
  const [simReq, setSimReq] = useState<ContractSimRequest | null>(null);
  const [simResult, setSimResult] = useState<ContractSimResponse | null>(null);

  const contractedKva = power?.contractedKva ?? 0;
  const yearlyPeakKva = power?.yearlyPeakKva ?? 0;
  const suggestedIdealKva = power?.suggestedIdealKva ?? 0;
  const usagePctOfContracted = power?.usagePctOfContracted ?? 0;

  useEffect(() => {
    if (!exportOpen) return;

    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (exportRef.current && !exportRef.current.contains(target)) {
        setExportOpen(false);
      }
    }

    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [exportOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    try {
      const photo = localStorage.getItem('kynex:profilePhotoUrl');
      if (photo) setUserPhotoUrl(photo);

      let email: string | undefined = undefined;
      let name: string | undefined = undefined;
      const onboardRaw = localStorage.getItem('kynex:onboarding');
      if (onboardRaw) {
        const parsed = JSON.parse(onboardRaw) as { name?: string; email?: string };
        if (parsed?.name) name = parsed.name;
        if (parsed?.email) email = parsed.email;
      }

      if (!email) {
        const registeredEmail = localStorage.getItem('kynex:registeredEmail');
        if (registeredEmail) email = registeredEmail;
      }
      setUserEmail(email || '');
      if (name) setCustomerName(name);
    } catch {
      // ignore
    }
  }, [settingsOpen]);

  useEffect(() => {
    try {
      const id = localStorage.getItem('kynex:customerId');
      setCustomerId(id);

      // Verifica se deve abrir o menu ao retornar de uma página de configurações
      const shouldOpenSettings = localStorage.getItem('openSettingsOnReturn');
      if (shouldOpenSettings === 'true') {
        localStorage.removeItem('openSettingsOnReturn');
        setSettingsOpen(true);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const apiBases = [
      (import.meta as any).env?.VITE_API_BASE as string | undefined,
      'http://localhost:4100'
    ].filter(Boolean) as string[];

    let cancelled = false;

    async function resolveBase() {
      for (const base of apiBases) {
        try {
          const controller = new AbortController();
          const t = window.setTimeout(() => controller.abort(), 1200);
          const res = await fetch(`${base}/health`, { signal: controller.signal });
          window.clearTimeout(t);
          if (!res.ok) continue;
          if (!cancelled) setApiBase(base);
          return;
        } catch {
          // tenta próxima base
        }
      }
    }

    resolveBase();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!apiBase || !customerId) return;

    let cancelled = false;

    async function loadSeries() {
      try {
        const token = localStorage.getItem('kynex:authToken');

        const qp = new URLSearchParams();
        qp.set('range', range);

        if (rangeMode === 'periodo') {
          const fromIso = toIsoOrNullFromLocalInput(periodFromLocal);
          const toIso = toIsoOrNullFromLocalInput(periodToLocal);
          if (fromIso) qp.set('from', fromIso);
          if (toIso) qp.set('to', toIso);
          qp.set('granularity', periodGranularity);
        } else if (rangeMode === 'dia') {
          qp.set('granularity', '15m');
          if (selectedDay) qp.set('date', selectedDay);
        } else if (rangeMode === 'semana' && Number.isFinite(weekDays)) {
          qp.set('days', String(weekDays));
        }

        const res = await fetch(`${apiBase}/customers/${customerId}/analytics/consumption?${qp.toString()}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('series');
        const json = (await res.json()) as ConsumptionSeriesResponse;
        if (!cancelled) setSeries(json);
      } catch {
        if (!cancelled) setSeries({ range, labels: [], values: [], lastUpdated: '' });
      }
    }

    async function loadPower() {
      try {
        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(`${apiBase}/customers/${customerId}/power/suggestion`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('power');
        const json = (await res.json()) as PowerSuggestionResponse;
        if (!cancelled) setPower(json);
      } catch {
        if (!cancelled) setPower(null);
      }
    }

    async function loadHourlyEfficiency() {
      try {
        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(`${apiBase}/customers/${customerId}/analytics/hourly-efficiency`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('eff');
        const json = (await res.json()) as HourlyEfficiencyResponse;
        if (!cancelled) setEff(json);
      } catch {
        if (!cancelled) setEff(null);
      }
    }

    async function loadElectricalHealth() {
      try {
        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(`${apiBase}/customers/${customerId}/analytics/electrical-health`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('electrical');
        const json = (await res.json()) as ElectricalHealthResponse;
        if (!cancelled) setElec(json);
      } catch {
        if (!cancelled) setElec(null);
      }
    }

    async function loadContract() {
      try {
        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(`${apiBase}/customers/${customerId}/contract/analysis`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('contract');
        const json = (await res.json()) as ContractAnalysisResponse;
        if (!cancelled) setContract(json);
      } catch {
        if (!cancelled) setContract(null);
      }
    }

    async function loadOffers() {
      try {
        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(`${apiBase}/customers/${customerId}/market/offers`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('offers');
        const json = (await res.json()) as MarketOffersResponse;
        if (!cancelled) setOffers(json);
      } catch {
        if (!cancelled) setOffers(null);
      }
    }

    async function loadInsights() {
      try {
        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(`${apiBase}/customers/${customerId}/ai/insights?limit=3`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('insights');
        const json = (await res.json()) as InsightsResponse;
        if (!cancelled) setInsights(json);
      } catch {
        if (!cancelled) setInsights(null);
      }
    }

    loadSeries();
    loadPower();
    loadHourlyEfficiency();
    loadElectricalHealth();
    loadContract();
    loadOffers();
    loadInsights();

    const id = window.setInterval(() => {
      loadSeries();
      loadPower();
      loadHourlyEfficiency();
      loadElectricalHealth();
      loadContract();
      loadOffers();
      loadInsights();
    }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [apiBase, customerId, range, rangeMode, selectedDay, weekDays, periodFromLocal, periodToLocal, periodGranularity]);

  const effScore = typeof eff?.scorePct === 'number' ? eff.scorePct : null;
  const effNote = eff?.note ?? 'A calcular com base no seu histórico e no modelo.';
  const effSavings = typeof eff?.estimatedSavingsMonthEur === 'number' ? eff.estimatedSavingsMonthEur : null;

  const elecPct = typeof elec?.healthPct === 'number' ? elec.healthPct : null;
  const elecContracted = typeof elec?.contractedPowerKva === 'number' ? elec.contractedPowerKva : null;
  const elecInUse = typeof elec?.powerInUseKva === 'number' ? elec.powerInUseKva : null;
  const elecWarning = elec?.warning ?? null;

  const elecStatus = elec?.status ?? null;
  const elecStatusLabel = elecStatus === 'risco' ? 'Risco' : elecStatus === 'atencao' ? 'Atenção' : elecStatus === 'ok' ? 'Ok' : '—';

  const contractVazio = typeof contract?.current?.price_vazio_eur_per_kwh === 'number' ? contract.current.price_vazio_eur_per_kwh : null;
  const contractCheia = typeof contract?.current?.price_cheia_eur_per_kwh === 'number' ? contract.current.price_cheia_eur_per_kwh : null;
  const contractFixed = typeof contract?.current?.fixed_daily_fee_eur === 'number' ? contract.current.fixed_daily_fee_eur : null;
  const contractSuggestion = contract?.suggestion?.message ?? 'A analisar o seu contrato e o seu padrão de consumo.';

  const bestOffer = offers?.best ?? null;
  const offerSaveYear = typeof bestOffer?.savingsYearEur === 'number' ? bestOffer.savingsYearEur : null;

  const insightCards = insights?.tips?.length
    ? insights.tips
    : [
        { id: 'fallback-1', icon: '✦', text: 'A gerar dicas personalizadas com base na sua telemetria.' },
        { id: 'fallback-2', icon: '✦', text: 'Assim que houver dados suficientes, sugerimos ações concretas e quantificadas.' }
      ];

  function fmtEur(v: number | null) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    return `${v.toFixed(4).replace('.', ',')}€`;
  }

  function fmtEur2(v: number | null) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    return `${v.toFixed(2).replace('.', ',')}€`;
  }

  async function openPriceSimulator() {
    if (!contract) {
      setPriceModalOpen(true);
      setSimReq({ tariff: 'Simples', price_vazio_eur_per_kwh: 0.18, price_cheia_eur_per_kwh: 0.18, fixed_daily_fee_eur: 0.22 });
      return;
    }

    setPriceModalOpen(true);
    setSimResult(null);
    setSimReq({
      tariff: contract.suggestion?.tariff ?? contract.current.tariff ?? 'Simples',
      price_vazio_eur_per_kwh: contract.current.price_vazio_eur_per_kwh,
      price_cheia_eur_per_kwh: contract.current.price_cheia_eur_per_kwh,
      fixed_daily_fee_eur: contract.current.fixed_daily_fee_eur
    });
  }

  async function runSimulation() {
    if (!apiBase || !customerId || !simReq) return;
    try {
      const token = localStorage.getItem('kynex:authToken');
      const res = await fetch(`${apiBase}/customers/${customerId}/contract/simulate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(simReq)
      });
      if (!res.ok) throw new Error('simulate');
      const json = (await res.json()) as ContractSimResponse;
      setSimResult(json);
    } catch {
      setSimResult(null);
    }
  }

  useEffect(() => {
    if (!powerModalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setPowerModalOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [powerModalOpen]);

  useEffect(() => {
    if (!priceModalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setPriceModalOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [priceModalOpen]);

  useEffect(() => {
    if (!offersModalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOffersModalOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [offersModalOpen]);

  const powerAlternatives = (power?.alternatives ?? []).slice().sort((a, b) => a.score - b.score);
  const currentAlt = powerAlternatives.find((a) => Math.abs(a.kva - (power?.contractedKva ?? 0)) < 1e-6);
  const bestAlt = powerAlternatives[0];
  const savingsMonth = (typeof power?.savingsMonth === 'number' ? power.savingsMonth : null);

  const labels = series.labels.length
    ? series.labels
    : (range === 'dia' 
      ? Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`)
      : range === 'semana' ? ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'] : Array.from({ length: 30 }, (_, i) => `${i + 1}`));
  const values = series.values.length ? series.values : Array.from({ length: labels.length }, () => 0);

  const monthTicks = useMemo(() => {
    if (range === 'dia') {
      // Para dia, mostrar cada 3 horas (0, 3, 6, 9, 12, 15, 18, 21, 23)
      return ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '23:00'];
    }
    const last = labels[labels.length - 1] ?? '30';
    const base = ['1', '5', '10', '15', '20', '25', last];
    return Array.from(new Set(base));
  }, [labels, range]);

  const xTicks = useMemo(() => {
    if (range === 'semana') return labels;
    if (range === 'mes') return monthTicks;
    // dia (inclui custom). Para séries longas, reduz para ~8 ticks.
    if (labels.length <= 12) return labels;
    if (labels.length === 24 || labels.length === 96) return monthTicks;
    const step = Math.max(1, Math.ceil(labels.length / 8));
    const ticks = labels.filter((_, i) => i % step === 0);
    const last = labels[labels.length - 1];
    if (last && ticks[ticks.length - 1] !== last) ticks.push(last);
    return ticks;
  }, [labels, monthTicks, range]);

  const chart = useMemo(() => {
    const width = 360;
    const height = 200;
    const { d, pts, min, max } = buildLinePath(values, width, height);
    const area = `${d} L ${pts[pts.length - 1].x.toFixed(2)} ${(height - 14).toFixed(2)} L ${pts[0].x.toFixed(2)} ${(height - 14).toFixed(2)} Z`;
    const last = pts[pts.length - 1];
    return { width, height, d, area, min, max, last };
  }, [values]);

  function exportPdf() {
    setExportOpen(false);
    window.setTimeout(() => window.print(), 50);
  }

  return (
    <div className="app-shell">
      <div className="phone-frame">
        <header className="top-bar">
          <div className="brand">
            <button className="brand-logo" type="button" onClick={() => window.location.assign('/dashboard')} aria-label="Ir para Dashboard">
              <img src={logoImg} alt="Kynex" />
            </button>
          </div>
          <div className="top-actions">
            <button className="notif-btn" aria-label="Notificações" type="button">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path
                  d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-5-5.9V4a1 1 0 0 0-2 0v1.1A6 6 0 0 0 6 11v3.2c0 .5-.2 1-.6 1.4L4 17h5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M9 17a3 3 0 0 0 6 0" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="notif-badge">2</span>
            </button>
            <button
              className="avatar-btn"
              aria-label="Perfil"
              type="button"
              onClick={() => setSettingsOpen(true)}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-3.314 3.134-6 7-6h2c3.866 0 7 2.686 7 6" />
              </svg>
            </button>
          </div>
        </header>

        <SettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          user={{ name: customerName, email: userEmail, photoUrl: userPhotoUrl }}
          onUserUpdate={(patch) => {
            if (typeof patch.name === 'string') setCustomerName(patch.name);
            if (typeof patch.email === 'string') setUserEmail(patch.email);
            if (typeof patch.photoUrl === 'string' || patch.photoUrl === null) setUserPhotoUrl(patch.photoUrl ?? null);
          }}
        />

        <div className="brand-text ana-brand-text">
          <h1 className="brand-title">Análise dos <b>consumos</b></h1>
        </div>

        <main className="content">
          {priceModalOpen && (
            <div
              className="ana-modal-overlay"
              role="dialog"
              aria-modal="true"
              aria-label="Simulador de preços"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setPriceModalOpen(false);
              }}
            >
              <div className="ana-modal">
                <div className="ana-modal-header">
                  <div className="ana-modal-title">Simulador de Preços</div>
                  <button className="ana-modal-close" type="button" aria-label="Fechar" onClick={() => setPriceModalOpen(false)}>
                    ×
                  </button>
                </div>

                <div className="ana-modal-subtitle">
                  Ajuste os preços e compare com o seu custo estimado. Última leitura: <strong>{formatPtDateTime(contract?.lastUpdated ?? series.lastUpdated)}</strong>
                </div>

                <div className="ana-modal-grid">
                  <div className="ana-modal-card">
                    <div className="ana-modal-card-title">Preços a simular</div>

                    <div className="ana-modal-kpis" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      <div className="ana-modal-kpi">
                        <div className="ana-modal-kpi-label">Tarifário</div>
                        <div className="ana-modal-kpi-value" style={{ fontSize: 14 }}>
                          <select
                            value={simReq?.tariff ?? 'Simples'}
                            onChange={(e) => setSimReq((v) => ({
                              tariff: e.target.value,
                              price_vazio_eur_per_kwh: v?.price_vazio_eur_per_kwh ?? 0.18,
                              price_cheia_eur_per_kwh: v?.price_cheia_eur_per_kwh ?? 0.18,
                              fixed_daily_fee_eur: v?.fixed_daily_fee_eur ?? 0.22
                            }))}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.15)', color: 'inherit' }}
                          >
                            <option value="Simples">Simples</option>
                            <option value="Bi-horário">Bi-horário</option>
                          </select>
                        </div>
                      </div>

                      <div className="ana-modal-kpi">
                        <div className="ana-modal-kpi-label">Termo fixo / dia (€)</div>
                        <div className="ana-modal-kpi-value" style={{ fontSize: 14 }}>
                          <input
                            type="number"
                            step="0.0001"
                            value={typeof simReq?.fixed_daily_fee_eur === 'number' ? simReq.fixed_daily_fee_eur : ''}
                            onChange={(e) => setSimReq((v) => ({
                              tariff: v?.tariff ?? 'Simples',
                              price_vazio_eur_per_kwh: v?.price_vazio_eur_per_kwh ?? 0.18,
                              price_cheia_eur_per_kwh: v?.price_cheia_eur_per_kwh ?? 0.18,
                              fixed_daily_fee_eur: Number(e.target.value)
                            }))}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.15)', color: 'inherit' }}
                          />
                        </div>
                      </div>

                      <div className="ana-modal-kpi">
                        <div className="ana-modal-kpi-label">Preço Vazio (€/kWh)</div>
                        <div className="ana-modal-kpi-value" style={{ fontSize: 14 }}>
                          <input
                            type="number"
                            step="0.0001"
                            value={typeof simReq?.price_vazio_eur_per_kwh === 'number' ? simReq.price_vazio_eur_per_kwh : ''}
                            onChange={(e) => setSimReq((v) => ({
                              tariff: v?.tariff ?? 'Simples',
                              price_vazio_eur_per_kwh: Number(e.target.value),
                              price_cheia_eur_per_kwh: v?.price_cheia_eur_per_kwh ?? 0.18,
                              fixed_daily_fee_eur: v?.fixed_daily_fee_eur ?? 0.22
                            }))}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.15)', color: 'inherit' }}
                          />
                        </div>
                      </div>

                      <div className="ana-modal-kpi">
                        <div className="ana-modal-kpi-label">Preço Cheia (€/kWh)</div>
                        <div className="ana-modal-kpi-value" style={{ fontSize: 14 }}>
                          <input
                            type="number"
                            step="0.0001"
                            value={typeof simReq?.price_cheia_eur_per_kwh === 'number' ? simReq.price_cheia_eur_per_kwh : ''}
                            onChange={(e) => setSimReq((v) => ({
                              tariff: v?.tariff ?? 'Simples',
                              price_vazio_eur_per_kwh: v?.price_vazio_eur_per_kwh ?? 0.18,
                              price_cheia_eur_per_kwh: Number(e.target.value),
                              fixed_daily_fee_eur: v?.fixed_daily_fee_eur ?? 0.22
                            }))}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.15)', color: 'inherit' }}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="ana-modal-actions">
                      <button className="ana-modal-secondary" type="button" onClick={() => setPriceModalOpen(false)}>
                        Fechar
                      </button>
                      <button className="ana-modal-primary" type="button" onClick={runSimulation}>
                        Simular
                      </button>
                    </div>
                  </div>

                  <div className="ana-modal-card">
                    <div className="ana-modal-card-title">Resultado</div>
                    <div className="ana-modal-note">
                      {simResult ? (
                        <>
                          <div style={{ display: 'grid', gap: 8 }}>
                            <div>
                              <strong>Atual:</strong> {fmtEur2(simResult.current.total)} / mês
                            </div>
                            <div>
                              <strong>Proposto:</strong> {fmtEur2(simResult.proposed.total)} / mês
                            </div>
                            <div>
                              <strong>Poupança:</strong> {fmtEur2(simResult.savingsMonthEur)} / mês
                            </div>
                          </div>
                        </>
                      ) : (
                        <div style={{ opacity: 0.75 }}>Clique em “Simular” para calcular.</div>
                      )}
                    </div>
                    <div className="ana-modal-footnote">
                      Estimativa baseada no seu consumo recente e distribuição Vazio/Cheia.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {offersModalOpen && (
            <div
              className="ana-modal-overlay"
              role="dialog"
              aria-modal="true"
              aria-label="Ofertas do mercado"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setOffersModalOpen(false);
              }}
            >
              <div className="ana-modal">
                <div className="ana-modal-header">
                  <div className="ana-modal-title">Ofertas do Mercado</div>
                  <button className="ana-modal-close" type="button" aria-label="Fechar" onClick={() => setOffersModalOpen(false)}>
                    ×
                  </button>
                </div>

                <div className="ana-modal-subtitle">
                  Comparação estimada com base no seu consumo. Última leitura: <strong>{formatPtDateTime(offers?.lastUpdated ?? series.lastUpdated)}</strong>
                </div>

                <div className="ana-modal-table-wrap">
                  <div className="ana-modal-card-title">Ranking</div>
                  <table className="ana-modal-table" aria-label="Tabela de ofertas">
                    <thead>
                      <tr>
                        <th>Oferta</th>
                        <th>Tarifa</th>
                        <th>€/mês</th>
                        <th>Poupança/ano</th>
                      </tr>
                    </thead>
                    <tbody>
                      {offers?.offers?.length ? (
                        offers.offers.map((o) => (
                          <tr key={`${o.provider}:${o.name}:${o.tariff}`} className={bestOffer && o.name === bestOffer.name ? 'best' : ''}>
                            <td>
                              <strong>{o.provider}</strong> — {o.name}
                              <div style={{ opacity: 0.75, fontSize: 12, marginTop: 4 }}>{o.why}</div>
                            </td>
                            <td>{o.tariff}</td>
                            <td>{fmtEur2(o.estimatedMonthEur)}</td>
                            <td>{fmtEur2(o.savingsYearEur)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={4} style={{ opacity: 0.75, padding: 10 }}>Sem dados suficientes para comparar ofertas.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="ana-modal-actions">
                  <button className="ana-modal-secondary" type="button" onClick={() => setOffersModalOpen(false)}>
                    Fechar
                  </button>
                </div>
              </div>
            </div>
          )}

          {powerModalOpen && (
            <div
              className="ana-modal-overlay"
              role="dialog"
              aria-modal="true"
              aria-label="Simular poupança de potência"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setPowerModalOpen(false);
              }}
            >
              <div className="ana-modal">
                <div className="ana-modal-header">
                  <div className="ana-modal-title">Simulação de Poupança — Potência</div>
                  <button className="ana-modal-close" type="button" aria-label="Fechar" onClick={() => setPowerModalOpen(false)}>
                    ×
                  </button>
                </div>

                <div className="ana-modal-subtitle">
                  Baseado no seu histórico e previsão (quando disponível). Última leitura: <strong>{formatPtDateTime(power?.lastUpdated ?? '')}</strong>
                </div>

                <div className="ana-modal-grid">
                  <div className="ana-modal-card">
                    <div className="ana-modal-card-title">Resumo</div>
                    <div className="ana-modal-kpis">
                      <div className="ana-modal-kpi">
                        <div className="ana-modal-kpi-label">Potência atual</div>
                        <div className="ana-modal-kpi-value">{power?.contractedKva ? `${power.contractedKva.toFixed(1)} kVA` : '—'}</div>
                      </div>
                      <div className="ana-modal-kpi">
                        <div className="ana-modal-kpi-label">Recomendação</div>
                        <div className="ana-modal-kpi-value">{power?.suggestedIdealKva ? `${power.suggestedIdealKva.toFixed(1)} kVA` : '—'}</div>
                      </div>
                      <div className="ana-modal-kpi">
                        <div className="ana-modal-kpi-label">Risco de exceder</div>
                        <div className="ana-modal-kpi-value">{typeof power?.riskExceedPct === 'number' ? `${power.riskExceedPct.toFixed(1)}%` : '—'}</div>
                      </div>
                    </div>

                    <div className="ana-modal-note">
                      <strong>{power?.title ?? '—'}</strong> {power?.message ?? '—'}
                    </div>

                    <div className="ana-modal-pill-row">
                      <span className="ana-modal-pill">Modelo: <strong>{power?.modelUsed === 'ai' ? 'IA' : 'Histórico'}</strong></span>
                      <span className="ana-modal-pill">Pico anual: <strong>{power?.yearlyPeakKva ? `${power.yearlyPeakKva.toFixed(1)} kVA` : '—'}</strong></span>
                      <span className="ana-modal-pill">Uso vs contratado: <strong>{typeof usagePctOfContracted === 'number' ? `${usagePctOfContracted}%` : '—'}</strong></span>
                    </div>
                  </div>

                  <div className="ana-modal-card">
                    <div className="ana-modal-card-title">Poupança (estimativa)</div>
                    <div className="ana-modal-savings">
                      <div className="ana-modal-savings-main">
                        {savingsMonth === null ? '—' : `${Math.max(0, savingsMonth).toFixed(2)} € / mês`}
                      </div>
                      <div className="ana-modal-savings-sub">
                        Estimativa no termo fixo da potência, comparando a opção recomendada com a sua potência atual.
                      </div>
                    </div>

                    <div className="ana-modal-footnote">
                      Nota: valores são aproximados. O termo fixo depende do comercializador/tarifa e pode não ser estritamente proporcional ao kVA.
                    </div>
                  </div>
                </div>

                <div className="ana-modal-table-wrap">
                  <div className="ana-modal-card-title">Alternativas (todas)</div>
                  <table className="ana-modal-table" aria-label="Tabela de alternativas de potência">
                    <thead>
                      <tr>
                        <th>kVA</th>
                        <th>Risco (%)</th>
                        <th>Termo fixo/mês (€)</th>
                        <th>Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {powerAlternatives.length ? (
                        powerAlternatives.map((a) => {
                          const isBest = bestAlt && a.kva === bestAlt.kva;
                          const isCurrent = currentAlt && a.kva === currentAlt.kva;
                          return (
                            <tr key={a.kva} className={`${isBest ? 'best' : ''} ${isCurrent ? 'current' : ''}`.trim()}>
                              <td>
                                <span className="ana-modal-kva">{a.kva.toFixed(2)}</span>
                                {isBest ? <span className="ana-modal-tag">Recomendado</span> : null}
                                {isCurrent ? <span className="ana-modal-tag alt">Atual</span> : null}
                              </td>
                              <td>{a.riskExceedPct.toFixed(1)}</td>
                              <td>{a.powerFeeMonth.toFixed(2)}</td>
                              <td>{a.score.toFixed(2)}</td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={4} style={{ opacity: 0.75, padding: 10 }}>Sem dados suficientes para simular alternativas.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="ana-modal-actions">
                  <button className="ana-modal-secondary" type="button" onClick={() => setPowerModalOpen(false)}>
                    Fechar
                  </button>
                  <button
                    className="ana-modal-primary"
                    type="button"
                    onClick={() => {
                      // por agora só fecha; futuramente pode levar para “Simulador de Preços”
                      setPowerModalOpen(false);
                    }}
                  >
                    Continuar
                  </button>
                </div>
              </div>
            </div>
          )}

          <section className="ana-card" aria-label="Análise do consumo">
            <div className="ana-card-header">
              <div className="ana-card-title">Análise do <b>Consumo</b></div>
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }} aria-label="Última leitura (tempo simulado)">
                Última leitura: <strong>{formatPtDateTime(series.lastUpdated)}</strong>
              </div>

              <div className="ana-actions">
                <div className="segmented" role="tablist" aria-label="Intervalo">
                  <button
                    className={`seg-btn ${rangeMode === 'dia' ? 'active' : ''}`}
                    onClick={() => setRangeMode('dia')}
                    type="button"
                    role="tab"
                    aria-selected={rangeMode === 'dia'}
                  >
                    Diário
                  </button>
                  <button
                    className={`seg-btn ${rangeMode === 'semana' ? 'active' : ''}`}
                    onClick={() => setRangeMode('semana')}
                    type="button"
                    role="tab"
                    aria-selected={rangeMode === 'semana'}
                  >
                    Semanal
                  </button>
                  <button
                    className={`seg-btn ${rangeMode === 'mes' ? 'active' : ''}`}
                    onClick={() => setRangeMode('mes')}
                    type="button"
                    role="tab"
                    aria-selected={rangeMode === 'mes'}
                  >
                    Mensal
                  </button>
                  <button
                    className={`seg-btn ${rangeMode === 'periodo' ? 'active' : ''}`}
                    onClick={() => setRangeMode('periodo')}
                    type="button"
                    role="tab"
                    aria-selected={rangeMode === 'periodo'}
                  >
                    Período
                  </button>
                </div>

                {rangeMode === 'dia' && (
                  <div className="ana-control-group" aria-label="Selecionar dia">
                    <label className="ana-label">Dia</label>
                    <input
                      type="date"
                      value={selectedDay}
                      onChange={(e) => setSelectedDay(e.target.value)}
                      max={todayUtcDayKey()}
                      className="ana-input"
                      aria-label="Dia (UTC)"
                    />
                  </div>
                )}

                {rangeMode === 'semana' && (
                  <div className="ana-control-group" aria-label="Período (dias)">
                    <label className="ana-label">Período</label>
                    <select
                      value={String(weekDays)}
                      onChange={(e) => setWeekDays(Number(e.target.value))}
                      className="ana-input"
                      aria-label="Últimos dias"
                    >
                      <option value="7">7 dias</option>
                      <option value="14">14 dias</option>
                      <option value="30">30 dias</option>
                    </select>
                  </div>
                )}

                {rangeMode === 'periodo' && (
                  <div className="ana-control-group ana-period-controls" aria-label="Período personalizado">
                    <div className="ana-period-row">
                      <div className="ana-period-col">
                        <label className="ana-label">De</label>
                        <input
                          type="datetime-local"
                          value={periodFromLocal}
                          onChange={(e) => setPeriodFromLocal(e.target.value)}
                          className="ana-input"
                          aria-label="Data/hora inicial"
                        />
                      </div>
                      <div className="ana-period-col">
                        <label className="ana-label">Até</label>
                        <input
                          type="datetime-local"
                          value={periodToLocal}
                          onChange={(e) => setPeriodToLocal(e.target.value)}
                          className="ana-input"
                          aria-label="Data/hora final"
                        />
                      </div>
                      <div className="ana-period-col">
                        <label className="ana-label">Granularidade</label>
                        <select
                          value={periodGranularity}
                          onChange={(e) => setPeriodGranularity(e.target.value as any)}
                          className="ana-input"
                          aria-label="Granularidade"
                        >
                          <option value="15m">15 min</option>
                          <option value="1h">1 hora</option>
                          <option value="1d">1 dia</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                <div className="ana-export" ref={exportRef}>
                  <button
                    className="ana-export-btn"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={exportOpen}
                    onClick={() => setExportOpen((v) => !v)}
                  >
                    Exportar
                    <span className="ana-caret" aria-hidden="true">▾</span>
                  </button>

                  {exportOpen && (
                    <div className="ana-export-menu" role="menu" aria-label="Exportar">
                      <button className="ana-export-item" type="button" role="menuitem" onClick={exportPdf}>
                        PDF
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="ana-chart" aria-label="Gráfico de consumo">
              <svg
                className="ana-svg"
                viewBox={`0 0 ${chart.width} ${chart.height}`}
                role="img"
                aria-label="Linha de consumo"
              >
                <defs>
                  <linearGradient id="anaFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(141, 224, 255, 0.30)" />
                    <stop offset="100%" stopColor="rgba(141, 224, 255, 0.02)" />
                  </linearGradient>
                </defs>

                <path d={chart.area} fill="url(#anaFill)" />
                <path d={chart.d} className="ana-line" fill="none" />

                <circle cx={chart.last.x} cy={chart.last.y} r="3.5" className="ana-dot" />
              </svg>

              <div className="ana-x">
                {xTicks.map((l) => (
                  <span key={l} className="ana-x-tick">{l}</span>
                ))}
              </div>
            </div>
          </section>

          <section className="ana-grid" aria-label="Sugestões e eficiência">
            <article className="ana-mini-card" aria-label="Potência">
              <div className="ana-mini-head">
                <div className="ana-mini-title">Potência</div>
                <button className="ana-mini-help" type="button" aria-label="Ajuda">?</button>
              </div>

              <div className="ana-mini-body">
                <div className="ana-power-meter" aria-label="Resumo de potência">
                  <div className="ana-power-top">
                    <div className="ana-power-value">
                      <div className="ana-power-num">{contractedKva ? contractedKva.toFixed(1) : '—'}</div>
                      <div className="ana-power-unit">kVA</div>
                    </div>
                    <div className="ana-power-label">Contratada</div>
                  </div>

                  <div className="ana-power-mid">
                    <div className="ana-power-value">
                      <div className="ana-power-num">{yearlyPeakKva ? yearlyPeakKva.toFixed(1) : '—'}</div>
                      <div className="ana-power-unit">kVA</div>
                    </div>
                    <div className="ana-power-label">Pico anual</div>
                  </div>

                  <div className="ana-power-max">MÁX</div>
                </div>

                <div className="ana-mini-copy">
                  <div className="ana-mini-kpi">
                    Potência Ideal Sugerida: <strong>{suggestedIdealKva ? `${suggestedIdealKva.toFixed(1)}kVA` : '—'}</strong>
                  </div>
                  <div className="ana-mini-pill" role="note">
                    <strong>{power?.title ?? '—'}</strong> {power ? power.message : 'A calcular sugestão com base no seu histórico.'}
                  </div>

                  <button
                    className="ana-mini-cta"
                    type="button"
                    onClick={() => setPowerModalOpen(true)}
                    disabled={!power}
                    aria-disabled={!power}
                    title={!power ? 'Sem dados suficientes para simular' : 'Abrir simulação'}
                  >
                    Simular Poupança
                    <span className="ana-mini-cta-icon" aria-hidden="true">↗</span>
                  </button>
                </div>
              </div>
            </article>

            <article
              className={`ana-mini-card ana-health-card ${elecStatus ? `ana-health--${elecStatus}` : ''}`}
              aria-label="Saúde Elétrica da Casa"
            >
              <div className="ana-mini-head">
                <div className="ana-mini-title">Saúde Elétrica da Casa</div>
                <div className={`ana-health-badge ${elecStatus ? `ana-health-badge--${elecStatus}` : ''}`}>{elecStatusLabel}</div>
              </div>

              <div className="ana-health-body">
                <div className="ana-health-left" aria-label="Percentagem de saúde elétrica">
                  <div className="ana-health-pct">{typeof elecPct === 'number' ? `${elecPct}%` : '—'}</div>
                  <div className="ana-health-sub">Status atual</div>
                </div>

                <div className="ana-health-right" aria-label="Métricas de potência">
                  <div className="ana-health-metric">
                    <div className="ana-health-metric-label">Potência Contratada</div>
                    <div className="ana-health-metric-val">{typeof elecContracted === 'number' ? `${elecContracted.toFixed(1)} kVA` : '—'}</div>
                  </div>
                  <div className="ana-health-metric">
                    <div className="ana-health-metric-label">Potência em Uso</div>
                    <div className="ana-health-metric-val">{typeof elecInUse === 'number' ? `${elecInUse.toFixed(1)} kVA` : '—'}</div>
                  </div>
                </div>
              </div>

              {elecWarning ? <div className="ana-health-warning">{elecWarning}</div> : null}
            </article>

            <article className="ana-mini-card" aria-label="Eficiência Horária">
              <div className="ana-mini-head">
                <div className="ana-mini-title">Eficiência Horária</div>
                <button className="ana-mini-help" type="button" aria-label="Ajuda">?</button>
              </div>

              <div className="ana-mini-body">
                <div className="ana-eff">
                  <div className="ana-eff-gauge" aria-label={`Eficiência ${effScore ?? '—'}%`}>
                    <div className="ana-eff-gauge-inner">
                      <div className="ana-eff-gauge-value">{typeof effScore === 'number' ? `${effScore}%` : '—'}</div>
                    </div>
                  </div>

                  <div className="ana-eff-copy">
                    <div className="ana-eff-note">{effNote}</div>
                    <button className="ana-eff-cta" type="button">
                      <span className="ana-eff-cta-col">
                        <strong>Movimentos Inteligentes🧠</strong>
                        <span className="ana-eff-save">
                          {typeof effSavings === 'number' ? `Poupe até ~${effSavings.toFixed(0)}€/mês` : '—'}
                        </span>
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </article>
          </section>

          <section className="ana-contract-card" aria-label="Análise contratual">
            <div className="ana-contract-head">
              <div className="ana-contract-title">Análise Contratual</div>
              <button className="ana-contract-cta" type="button" onClick={openPriceSimulator}>
                Simulador de Preços
                <span className="ana-contract-cta-icon" aria-hidden="true">↗</span>
              </button>
            </div>

            <div className="ana-contract-body">
              <div className="ana-contract-left" aria-label="Contrato atual">
                <div className="ana-contract-left-title">Contrato atual</div>

                <div className="ana-contract-pills">
                  <div className="ana-contract-pill-group">
                    <div className="ana-contract-pill-label">kWh/hora</div>
                    <div className="ana-contract-pill">
                      <span className="ana-contract-pill-key">Vazio:</span>
                        <span className="ana-contract-pill-val">{fmtEur(contractVazio)}</span>
                    </div>
                    <div className="ana-contract-pill">
                      <span className="ana-contract-pill-key">Cheia:</span>
                        <span className="ana-contract-pill-val">{fmtEur(contractCheia)}</span>
                    </div>
                  </div>

                  <div className="ana-contract-pill-group">
                    <div className="ana-contract-pill-label">Potência/dia</div>
                    <div className="ana-contract-pill big">
                      <span className="ana-contract-pill-val">{fmtEur(contractFixed)}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="ana-contract-right" aria-label="Ofertas">
                <div className="ana-contract-right-text">
                  {bestOffer ? bestOffer.why : contractSuggestion}
                </div>

                <div className="ana-contract-save">
                  {typeof offerSaveYear === 'number' ? `Poupe até ~${offerSaveYear.toFixed(0)}€/ano` : 'A procurar ofertas vantajosas…'}
                </div>

                <button className="ana-contract-offers" type="button" onClick={() => setOffersModalOpen(true)}>
                  Ver Ofertas
                  <span className="ana-contract-offers-icon" aria-hidden="true">↗</span>
                </button>
              </div>
            </div>
          </section>

          <section className="ana-insights" aria-label="Insights">
            {insightCards.slice(0, 3).map((t) => (
              <article key={t.id} className="ana-insight-card" aria-label="Insight">
                <div className="ana-insight-icon" aria-hidden="true">{t.icon || '✦'}</div>
                <div className="ana-insight-text">{t.text}</div>
              </article>
            ))}
          </section>
        </main>

        <div className="bottom-nav-wrapper">
          <div className="bottom-nav-container">
            <button className="assistant-cta" aria-label="Assistente IA" type="button" onClick={() => setAssistantOpen(true)}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L15.5 8.5L22 12L15.5 15.5L12 22L8.5 15.5L2 12L8.5 8.5L12 2Z" fill="currentColor" />
              </svg>
            </button>

            <nav className="bottom-nav">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  className={`nav-item ${item.key === 'stats' ? 'active' : ''}`}
                  onClick={() => window.location.assign(item.href)}
                  type="button"
                >
                  {item.icon}
                  <span className="nav-label">{item.label}</span>
                </button>
              ))}
            </nav>
          </div>
        </div>
      </div>

      <AssistantChatModal open={assistantOpen} onClose={() => setAssistantOpen(false)} apiBase={apiBase} customerId={customerId} />
    </div>
  );
}

export default Charts;
