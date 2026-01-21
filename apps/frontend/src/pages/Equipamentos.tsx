import React, { useEffect, useMemo, useState } from 'react';
import logoImg from '../assets/images/logo.png';
import AssistantChatModal from '../components/AssistantChatModal';
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
};

type AppliancesSummaryResponse = {
  customerId: string;
  lastUpdated: string;
  days: number;
  totalCostEur: number;
  items: AppliancesSummaryItem[];
  suggestion: string;
  estimatedSavingsMonthEur: number | null;
};

type HourlyEfficiencyResponse = {
  scorePct: number;
};

const monthOptions: MonthOption[] = [
  { value: 'jan', label: 'Janeiro' },
  { value: 'fev', label: 'Fevereiro' },
  { value: 'mar', label: 'Março' },
  { value: 'abr', label: 'Abril' },
  { value: 'mai', label: 'Maio' },
  { value: 'jun', label: 'Junho' },
  { value: 'jul', label: 'Julho' },
  { value: 'ago', label: 'Agosto' },
  { value: 'set', label: 'Setembro' },
  { value: 'out', label: 'Outubro' },
  { value: 'nov', label: 'Novembro' },
  { value: 'dez', label: 'Dezembro' },
];

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
    key: 'profile',
    label: 'Perfil',
    href: '/dashboard',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="7" r="4" />
        <path d="M5 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2" />
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
  const [month, setMonth] = useState('jun');

  const [assistantOpen, setAssistantOpen] = useState(false);

  const [apiBase, setApiBase] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [summary, setSummary] = useState<AppliancesSummaryResponse | null>(null);
  const [efficiencyPct, setEfficiencyPct] = useState<number | null>(null);

  useEffect(() => {
    try {
      const id = localStorage.getItem('kynex:customerId');
      setCustomerId(id);
    } catch {
      // ignore
    }
  }, []);

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
        const res = await fetch(`${apiBase}/customers/${customerId}/appliances/summary?days=30`, {
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
            <button className="avatar-btn" aria-label="Perfil" type="button">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-3.314 3.134-6 7-6h2c3.866 0 7 2.686 7 6" />
              </svg>
            </button>
          </div>
        </header>

        <div className="eq-title">
          <div className="eq-title-small">Os teus</div>
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
              {rows.map((row) => (
                <div key={row.id} className="eq-row">
                  <div className="eq-row-left">{row.icon}</div>
                  <div className="eq-row-mid">
                    <div className="eq-pill" style={{ width: `${Math.max(20, Math.min(100, row.barPct))}%` }}>
                      <span className="eq-pill-label">{row.label}</span>
                      <span className={`eq-pill-cost ${row.status}`}>{row.costLabel}</span>
                    </div>
                  </div>
                </div>
              ))}

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

          <section className="eq-grid" aria-label="Sugestões e eficiência">
            <div className="eq-mini-card">
              <div className="eq-mini-title">Sugestão do dia</div>
              <div className="eq-mini-body">{suggestionText}</div>
              {suggestionHighlight ? <div className="eq-mini-highlight">{suggestionHighlight}</div> : null}
              <button className="eq-help" type="button" aria-label="Ajuda">?</button>
            </div>

            <div className="eq-mini-card">
              <div className="eq-mini-title">Eficiência</div>
              <div className="eq-gauge" aria-label={`Eficiência ${effLabel}`}>
                <div className="eq-gauge-inner">
                  <div className="eq-gauge-value">{effLabel}</div>
                </div>
              </div>
              <button className="eq-help" type="button" aria-label="Ajuda">?</button>
            </div>
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
