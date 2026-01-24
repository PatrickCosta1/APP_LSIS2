import React, { useEffect, useMemo, useState } from 'react';
import logoImg from '../assets/images/logo.png';
import AssistantChatModal from '../components/AssistantChatModal';
import SettingsDrawer from '../components/SettingsDrawer';
import './Dashboard.css';
import './Equipamentos.css';

type MonthOption = { value: string; label: string };

type EquipmentStatus = 'normal' | 'anomalo';

type EquipmentRow = {
  id: string;
  label: string;
  icon: React.ReactNode;
  costLabel: string;
  status: EquipmentStatus;
  barPct: number; // 0-100
};

type AppliancesSummaryItem = {
  id: number;
  name: string;
  costEur: number;
  sharePct: number;
  status: 'Normal' | 'Atenção' | 'Anómalo';
  energyKwh?: number;
};

type AppliancesSummaryResponse = {
  customerId: string;
  lastUpdated: string;
  days: number;
  month?: string | null;
  totalCostEur: number;
  items: AppliancesSummaryItem[];
  suggestion: string;
  estimatedSavingsMonthEur: number | null;
};

type HourlyEfficiencyResponse = {
  scorePct: number;
};

type ContractAnalysisResponse = {
  customerId: string;
  lastUpdated: string;
  current: {
    tariff: string;
    price_vazio_eur_per_kwh: number;
    price_cheia_eur_per_kwh: number;
  };
};

type ApplianceWeeklyResponse = {
  customerId: string;
  applianceId: number;
  name: string;
  lastUpdated: string;
  days: number;
  totalKwh: number;
  totalCostEur: number;
  sharePct: number;
  daily: Array<{ day: string; kwh: number; costEur: number }>;
  tip: string;
};

function weekdayLetterPt(ymd: string) {
  const d = new Date(`${ymd}T00:00:00Z`);
  const wd = new Intl.DateTimeFormat('pt-PT', { weekday: 'short' }).format(d);
  // ex: "seg." → "S"
  return wd ? wd.charAt(0).toUpperCase() : '';
}

const monthLabelsPt = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function buildRecentMonthOptions(count: number): MonthOption[] {
  const base = new Date();
  const y0 = base.getFullYear();
  const m0 = base.getMonth(); // 0-11
  const out: MonthOption[] = [];
  for (let i = 0; i < count; i += 1) {
    const mIndex = m0 - i;
    const y = y0 + Math.floor(mIndex / 12);
    const m = ((mIndex % 12) + 12) % 12; // 0-11
    const value = `${y}-${pad2(m + 1)}`;
    const label = `${monthLabelsPt[m]} ${y}`;
    out.push({ value, label });
  }
  return out;
}

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

function iconFridge() {
  return (
    <svg className="eq-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
      <path d="M7 12h10" />
      <path d="M9 7h.01" />
      <path d="M9 17h.01" />
    </svg>
  );
}

function iconLight() {
  return (
    <svg className="eq-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12c.7.6 1 1.2 1 2h6c0-.8.3-1.4 1-2A7 7 0 0 0 12 2Z" />
    </svg>
  );
}

function iconWaterHeater() {
  return (
    <svg className="eq-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <path d="M9 7h6" />
      <path d="M9 11h6" />
      <path d="M9 15h6" />
    </svg>
  );
}

function iconStandby() {
  return (
    <svg className="eq-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2v10" />
      <path d="M6.2 5.2a8 8 0 1 0 11.3 0" />
    </svg>
  );
}

function iconAc() {
  return (
    <svg className="eq-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="8" rx="2" />
      <path d="M7 16c.5 1.2 1.5 2 3 2s2.5-.8 3-2" />
      <path d="M14 16c.5 1.2 1.5 2 3 2" />
      <path d="M7 20c.5 1 1.5 2 3 2" />
    </svg>
  );
}

function iconForApplianceName(name: string) {
  const n = String(name ?? '').toLowerCase();
  if (n.includes('frigor')) return iconFridge();
  if (n.includes('luz')) return iconLight();
  if (n.includes('água quente') || n.includes('termo')) return iconWaterHeater();
  if (n.includes('stand-by')) return iconStandby();
  if (n.includes('ar condicionado')) return iconAc();
  return iconStandby();
}

function Equipamentos() {
  const [month, setMonth] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  });

  const monthOptions = useMemo(() => buildRecentMonthOptions(12), []);

  const [assistantOpen, setAssistantOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customerName, setCustomerName] = useState<string>('Cliente');
  const [userEmail, setUserEmail] = useState<string>('');
  const [userPhotoUrl, setUserPhotoUrl] = useState<string | null>(null);

  const [apiBase, setApiBase] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [summary, setSummary] = useState<AppliancesSummaryResponse | null>(null);
  const [efficiencyPct, setEfficiencyPct] = useState<number | null>(null);
  const [contract, setContract] = useState<ContractAnalysisResponse | null>(null);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [weeklyById, setWeeklyById] = useState<Record<string, ApplianceWeeklyResponse | undefined>>({});

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
    const apiBases = [
      (import.meta as any).env?.VITE_API_BASE as string | undefined,
      'http://localhost:4000',
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

    async function load() {
      try {
        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(`${apiBase}/customers/${customerId}/appliances/summary?month=${encodeURIComponent(month)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('summary');
        const json = (await res.json()) as AppliancesSummaryResponse;
        if (!cancelled) setSummary(json);
      } catch {
        if (!cancelled) setSummary(null);
      }

      try {
        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(`${apiBase}/customers/${customerId}/analytics/hourly-efficiency?days=7`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('eff');
        const json = (await res.json()) as HourlyEfficiencyResponse;
        if (!cancelled) setEfficiencyPct(Number.isFinite(json.scorePct) ? json.scorePct : null);
      } catch {
        if (!cancelled) setEfficiencyPct(null);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [apiBase, customerId, month]);

  useEffect(() => {
    if (!apiBase || !customerId) return;
    let cancelled = false;

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

    loadContract();
    return () => {
      cancelled = true;
    };
  }, [apiBase, customerId]);

  const rows: EquipmentRow[] = useMemo(() => {
    if (!summary?.items?.length) return [];
    return summary.items.slice(0, 8).map((it) => ({
      id: String(it.id),
      label: it.name,
      icon: iconForApplianceName(it.name),
      costLabel: `${Number(it.costEur ?? 0).toFixed(1)}€`,
      status: it.status === 'Anómalo' ? 'anomalo' : 'normal',
      barPct: Math.max(0, Math.min(100, Number(it.sharePct ?? 0)))
    }));
  }, [summary]);

  const suggestionText = summary?.suggestion ?? 'A carregar…';
  const suggestionHighlight = summary?.estimatedSavingsMonthEur != null ? `-${summary.estimatedSavingsMonthEur.toFixed(1)} €/mês` : '';
  const effLabel = Number.isFinite(efficiencyPct as number) ? `${Math.round(efficiencyPct as number)}%` : '--%';

  const standbyItem = (summary?.items ?? []).find((x) => String(x.name ?? '').toLowerCase().includes('stand-by'));
  const standbyPct = standbyItem ? Math.max(0, Math.min(100, Number(standbyItem.sharePct ?? 0))) : 0;

  const totalEnergyKwh = (summary?.items ?? []).reduce((acc, x) => acc + (typeof x.energyKwh === 'number' ? x.energyKwh : 0), 0);
  const co2Kg = Math.round(totalEnergyKwh * 0.233);

  const tariff = String(contract?.current?.tariff ?? '');
  const tariffLower = tariff.toLowerCase();
  const isTou = tariffLower.includes('bi') || tariffLower.includes('tri');
  const isTri = tariffLower.includes('tri');

  const nowForPrice = (() => {
    const baseIso = contract?.lastUpdated || summary?.lastUpdated;
    const d = baseIso ? new Date(baseIso) : new Date();
    return Number.isNaN(d.getTime()) ? new Date() : d;
  })();

  const hourUtc = nowForPrice.getUTCHours();
  const isOffpeak = new Set<number>([22, 23, 0, 1, 2, 3, 4, 5, 6, 7]).has(hourUtc);
  const isPeakTri = new Set<number>([18, 19, 20, 21]).has(hourUtc);

  const priceVazio = typeof contract?.current?.price_vazio_eur_per_kwh === 'number' ? contract.current.price_vazio_eur_per_kwh : null;
  const priceCheia = typeof contract?.current?.price_cheia_eur_per_kwh === 'number' ? contract.current.price_cheia_eur_per_kwh : null;
  const pricePonta = priceCheia != null ? Number((priceCheia * 1.25).toFixed(4)) : null;

  type PriceStatus = 'low' | 'mid' | 'high';
  const priceStatus: PriceStatus = isOffpeak ? 'low' : isTri && isPeakTri ? 'high' : 'mid';

  const priceNow = isOffpeak ? priceVazio : priceStatus === 'high' ? pricePonta : priceCheia;
  const priceNowLabel = typeof priceNow === 'number' ? `${priceNow.toFixed(2)}€/kWh` : '—';

  const topApplianceName = rows.length ? rows[0].label.toLowerCase() : '';
  const priceTip = (() => {
    if (!isTou) return '';
    if (priceStatus === 'low') {
      if (topApplianceName.includes('lavar')) return 'Preço atual: Baixo. Ótima altura para ligar a máquina de lavar.';
      if (topApplianceName.includes('água quente') || topApplianceName.includes('termo')) return 'Preço atual: Baixo. Boa altura para aquecer água (se tiver termoacumulador).';
      return 'Preço atual: Baixo. Boa altura para tarefas flexíveis (lavar, aquecer água, carregar baterias).';
    }
    if (priceStatus === 'high') {
      return 'Preço atual: Alto. Evite tarefas intensivas (forno, ar condicionado, aquecimento de água) e adie para vazio.';
    }
    return 'Preço atual: Médio. Se puder, adie tarefas intensivas para vazio para poupar.';
  })();

  const trafficLight = (
    <svg width="54" height="54" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="18" y="8" width="28" height="48" rx="10" fill="rgba(0,0,0,0.22)" stroke="rgba(255,255,255,0.18)" />
      <circle cx="32" cy="21" r="7" fill={priceStatus === 'high' ? '#ff6b6b' : 'rgba(255,255,255,0.14)'} />
      <circle cx="32" cy="32" r="7" fill={priceStatus === 'mid' ? '#caff00' : 'rgba(255,255,255,0.14)'} />
      <circle cx="32" cy="43" r="7" fill={priceStatus === 'low' ? '#24e6b7' : 'rgba(255,255,255,0.14)'} />
    </svg>
  );

  const effPct = Number.isFinite(efficiencyPct as number) ? Math.max(0, Math.min(100, Math.round(efficiencyPct as number))) : null;
  const effDeg = effPct != null ? Math.round(effPct * 3.6) : 0;
  const effColor = effPct == null ? 'rgba(255, 255, 255, 0.12)' : effPct >= 75 ? '#24e6b7' : effPct >= 55 ? '#caff00' : '#ff6b6b';
  const effGaugeBg = `conic-gradient(${effColor} 0deg, ${effColor} ${effDeg}deg, rgba(255, 255, 255, 0.12) ${effDeg}deg 360deg)`;

  const helpIcon = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10v6" strokeLinecap="round" />
      <path d="M12 7h.01" strokeLinecap="round" />
    </svg>
  );

  const hoverData = hoveredId ? weeklyById[hoveredId] : undefined;
  const hoverMax = useMemo(() => {
    const vals = hoverData?.daily?.map((d) => d.kwh) ?? [];
    return Math.max(...vals, 0.001);
  }, [hoverData]);

  useEffect(() => {
    if (!hoveredId || !apiBase || !customerId) return;
    const id = hoveredId;
    if (weeklyById[id]) return;

    const controller = new AbortController();

    async function loadWeekly() {
      try {
        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(
          `${apiBase}/customers/${customerId}/appliances/${encodeURIComponent(id)}/weekly?days=7`,
          { signal: controller.signal, headers: token ? { Authorization: `Bearer ${token}` } : undefined }
        );
        if (!res.ok) throw new Error('weekly');
        const json = (await res.json()) as ApplianceWeeklyResponse;
        setWeeklyById((prev) => (prev[id] ? prev : { ...prev, [id]: json }));
      } catch {
        // ignore
      }
    }

    loadWeekly();
    return () => controller.abort();
  }, [hoveredId, apiBase, customerId, weeklyById]);

  return (
    <div className="app-shell">
      <div className="phone-frame">
        <header className="top-bar">
          <div className="brand">
            <div className="brand-logo">
              <img src={logoImg} alt="Kynex" />
            </div>
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

        <div className="eq-title">
          <div className="eq-title-small">Os meus</div>
          <div className="eq-title-big">Equipamentos</div>
        </div>

        <main className="content eq-content">
          <section className="eq-consumption-card" aria-label="Consumo por equipamento">
            <div className="eq-consumption-header">
              <div className="eq-consumption-title">Consumo</div>
              <label className="eq-month" aria-label="Selecionar mês">
                <select value={month} onChange={(e) => setMonth(e.target.value)}>
                  {monthOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="eq-rows">
              {rows.map((row) => {
                const isActive = hoveredId === row.id;
                const weekly = weeklyById[row.id];

                return (
                <div
                  key={row.id}
                  className={`eq-row ${isActive ? 'is-hovered' : ''}`}
                  tabIndex={0}
                  onMouseEnter={() => setHoveredId(row.id)}
                  onMouseLeave={() => setHoveredId((cur) => (cur === row.id ? null : cur))}
                  onFocus={() => setHoveredId(row.id)}
                  onBlur={() => setHoveredId((cur) => (cur === row.id ? null : cur))}
                >
                  <div className="eq-row-left">{row.icon}</div>
                  <div className="eq-row-mid">
                    <div className="eq-pill" style={{ width: `${Math.max(20, Math.min(100, row.barPct))}%` }}>
                      <span className="eq-pill-label">{row.label}</span>
                      <span className={`eq-pill-cost ${row.status}`}>{row.costLabel}</span>
                    </div>

                    {isActive ? (
                      <div className="eq-hover-card" role="dialog" aria-label={`Consumo semanal de ${row.label}`}>
                        <div className="eq-hover-header">
                          <div className="eq-hover-title">{row.label}</div>
                          <div className="eq-hover-total">
                            {weekly ? `${weekly.totalKwh.toFixed(2)} kWh` : 'A carregar…'}
                          </div>
                        </div>

                        <div className="eq-hover-sub">Consumo diário (7 dias)</div>
                        <div className="eq-hover-bars" aria-label="Consumo diário">
                          {(weekly?.daily ?? Array.from({ length: 7 }, (_, i) => ({ day: `d${i}`, kwh: 0, costEur: 0 }))).map((d, idx) => {
                            const h = weekly ? Math.max(8, Math.round((d.kwh / hoverMax) * 100)) : 12;
                            const label = weekly ? weekdayLetterPt(d.day) : '';
                            return (
                              <div key={`${d.day}-${idx}`} className="eq-hover-bar-col">
                                <div className="eq-hover-bar" style={{ height: `${h}%` }} />
                                <div className="eq-hover-bar-label">{label}</div>
                              </div>
                            );
                          })}
                        </div>

                        <div className="eq-hover-tip">{weekly?.tip ?? 'A carregar dica…'}</div>
                      </div>
                    ) : null}
                  </div>
                </div>
                );
              })}

              {!rows.length && (
                <div className="eq-row">
                  <div className="eq-row-mid" style={{ padding: '12px 0' }}>
                    <div className="eq-pill" style={{ width: '100%' }}>
                      <span className="eq-pill-label">Sem dados de equipamentos</span>
                      <span className="eq-pill-cost normal">--</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="eq-legend" aria-label="Legenda">
              <div className="eq-legend-item">
                <span className="eq-dot normal" /> Normal
              </div>
              <div className="eq-legend-item">
                <span className="eq-dot anomalo" /> Anómalo
              </div>
            </div>
          </section>

          <section className="eq-grid" aria-label="Cards">
            <div className="eq-mini-card">
              <div className="eq-mini-title">Consumo Fantasma</div>
              <div className="eq-mini-value danger">{Number.isFinite(standbyPct) ? `${standbyPct}%` : '--%'}</div>
              <div className="eq-mini-subtext">da sua fatura é desperdiçado em Stand-by.</div>
              
            </div>

            <div className="eq-mini-card">
              <div className="eq-mini-title">Impacto Ambiental</div>
              <div className="eq-mini-subtext">Este mês emitiu:</div>
              <div className="eq-mini-value danger">{Number.isFinite(co2Kg) ? `${co2Kg}kg` : '--kg'}</div>
              <div className="eq-mini-subtext">de CO2</div>
              
            </div>

            <div className="eq-mini-card">
              <div className="eq-mini-title">Sugestão do dia</div>
              <div className="eq-mini-body">{suggestionText}</div>
              {suggestionHighlight ? <div className="eq-mini-highlight">{suggestionHighlight}</div> : null}
              
            </div>

            <div className="eq-mini-card">
              <div className="eq-mini-title">Eficiência</div>
              <div className="eq-gauge" aria-label={`Eficiência ${effLabel}`} style={{ background: effGaugeBg }}>
                <div className="eq-gauge-inner">
                  <div className="eq-gauge-value">{effLabel}</div>
                </div>
              </div>
              
            </div>

            {isTou ? (
              <div className="eq-wide-card" role="region" aria-label="Preço da energia (agora)">
                <div className="eq-wide-title">Preço da Energia (Agora)</div>
                <div className="eq-wide-row">
                  <div className="eq-wide-icon">{trafficLight}</div>
                  <div className="eq-wide-text">
                    <div className="eq-wide-message">
                      <b>{priceTip}</b>
                    </div>
                    <div className="eq-wide-sub">
                      Tarifa: {tariff || '—'} · Hora: {pad2(hourUtc)}:00 · Preço: {priceNowLabel}
                    </div>
                  </div>
                </div>
                <button className="eq-help" type="button" aria-label="Mais info" onClick={() => setAssistantOpen(true)}>
                  {helpIcon}
                </button>
              </div>
            ) : null}
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
                  className={`nav-item ${item.key === 'devices' ? 'active' : ''}`}
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

export default Equipamentos;
