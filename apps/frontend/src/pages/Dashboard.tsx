import React, { useEffect, useState } from 'react';
import logoImg from '../assets/images/logo.png';
import casaImg from '../assets/images/casa_dia.png';
import AssistantChatModal from '../components/AssistantChatModal';
import './Dashboard.css';

type ChartItem = { label: string; value: number; kind: 'consumido' | 'previsto' };

type CustomerNowResponse = {
  customerId: string;
  name: string;
  lastUpdated: string;
  wattsNow: number;
  avgWattsLastHour: number;
  kwhLast24h: number;
  eurosLast24h: number;
  monthToDateKwh: number;
  monthToDateEuros: number;
  forecastMonthKwh: number;
  forecastMonthEuros: number;
  similarKwhLast24h: number;
  similarDeltaPct: number;
  priceEurPerKwh: number;
};

type CustomerChartResponse = {
  title: string;
  items: ChartItem[];
};

type IpmaForecastDay = {
  forecastDate: string;
  tMax?: string;
  tMin?: string;
  idWeatherType?: number;
};

type IpmaForecastResponse = {
  data: IpmaForecastDay[];
  globalIdLocal: number;
  dataUpdate?: string;
};

type IpmaWeatherType = {
  idWeatherType: number;
  descWeatherTypePT: string;
};

type IpmaWeatherTypesResponse = {
  data: IpmaWeatherType[];
};

function capitalizeFirstLetter(value: string) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatPtDateLabel(isoDate: string) {
  // IPMA devolve YYYY-MM-DD
  const date = new Date(`${isoDate}T00:00:00`);
  // pt-PT costuma devolver o mês em minúsculas
  const formatted = new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: 'long' }).format(date);
  return capitalizeFirstLetter(formatted);
}

function pickWeatherEmoji(descPT: string | undefined, idWeatherType: number | undefined) {
  const text = (descPT ?? '').toLowerCase();

  if (text.includes('trovoada')) return '⛈️';
  if (text.includes('granizo')) return '🌨️';
  if (text.includes('neve')) return '❄️';
  if (text.includes('nevoeiro') || text.includes('nuvens baixas') || text.includes('neblina')) return '🌫️';
  if (text.includes('chuva') || text.includes('aguaceiros') || text.includes('chuvisco') || text.includes('períodos de chuva') || text.includes('periodos de chuva')) return '🌧️';
  if (text.includes('céu limpo') || text.includes('ceu limpo')) return '☀️';
  if (text.includes('pouco nublado') || text.includes('parcialmente nublado')) return '🌤️';
  if (text.includes('muito nublado') || text.includes('encoberto') || text.includes('nublado')) return '☁️';

  // fallback simples por ranges mais comuns
  if (idWeatherType === 1) return '☀️';
  if (idWeatherType === 2 || idWeatherType === 3) return '🌤️';
  if (idWeatherType === 4 || idWeatherType === 5 || idWeatherType === 27) return '☁️';
  if (idWeatherType && idWeatherType >= 6 && idWeatherType <= 15) return '🌧️';
  if (idWeatherType === 18) return '❄️';
  if (idWeatherType === 19 || idWeatherType === 20 || idWeatherType === 23) return '⛈️';
  if (idWeatherType === 16 || idWeatherType === 17 || idWeatherType === 26) return '🌫️';

  return '🌡️';
}

const navItems = [
  { key: 'home', label: 'Home', href: '/dashboard', icon: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 9L12 2L21 9V20a2 2 0 0 1-2 2h-5a1 1 0 0 1-1-1v-6H11v6a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V9Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) },
  { key: 'stats', label: 'Estatísticas', href: '/graficos', icon: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 21V10M12 21V3M19 21v-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) },
  { key: 'devices', label: 'Dispositivos', href: '/equipamentos', icon: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
  ) },
  { key: 'profile', label: 'Perfil', href: '/dashboard', icon: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="7" r="4" />
      <path d="M5 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2" />
    </svg>
  ) },
];

function Dashboard() {
  const [activeTab, setActiveTab] = useState('home');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [topSection, setTopSection] = useState<'current' | 'chart'>('current');
  const [chartRange, setChartRange] = useState<'dia' | 'semana' | 'mes'>('dia');
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string>('Cliente');
  const [nowStats, setNowStats] = useState<CustomerNowResponse | null>(null);
  const [chart, setChart] = useState<CustomerChartResponse>({ title: 'Consumo', items: [] });
  const [isApiOnline, setIsApiOnline] = useState<boolean>(true);
  const [weather, setWeather] = useState<{ icon: string; tempLabel: string; dateLabel: string; ariaLabel: string; title?: string }>({
    icon: '🌡️',
    tempLabel: '—',
    dateLabel: '',
    ariaLabel: 'Meteorologia',
  });

  useEffect(() => {
    try {
      const id = localStorage.getItem('kynex:customerId');
      setCustomerId(id);

      const onboardRaw = localStorage.getItem('kynex:onboarding');
      if (onboardRaw) {
        const parsed = JSON.parse(onboardRaw) as { name?: string };
        if (parsed?.name) setCustomerName(parsed.name);
      }
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
          if (!cancelled) {
            setApiBase(base);
            setIsApiOnline(true);
          }
          return;
        } catch {
          // tenta próxima base
        }
      }
      if (!cancelled) setIsApiOnline(false);
    }

    resolveBase();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!apiBase || !customerId) return;

    let cancelled = false;

    async function loadNow() {
      try {
        const res = await fetch(`${apiBase}/customers/${customerId}/telemetry/now`);
        if (!res.ok) throw new Error('now');
        const json = (await res.json()) as CustomerNowResponse;
        if (!cancelled) {
          setNowStats(json);
          if (json?.name) setCustomerName(json.name);
          setIsApiOnline(true);
        }
      } catch {
        if (!cancelled) setIsApiOnline(false);
      }
    }

    async function loadChart() {
      try {
        const res = await fetch(`${apiBase}/customers/${customerId}/chart?range=${encodeURIComponent(chartRange)}`);
        if (!res.ok) throw new Error('chart');
        const json = (await res.json()) as CustomerChartResponse;
        if (!cancelled) setChart(json);
      } catch {
        // mantém gráfico atual
      }
    }

    loadNow();
    loadChart();

    const idNow = window.setInterval(loadNow, 8000);
    const idChart = window.setInterval(loadChart, 25000);
    return () => {
      cancelled = true;
      window.clearInterval(idNow);
      window.clearInterval(idChart);
    };
  }, [apiBase, customerId, chartRange]);

  const maxValue = React.useMemo(() => Math.max(...chart.items.map((i) => i.value), 1), [chart.items]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;

    // Porto (globalIdLocal) por defeito
    const globalIdLocal = 1131200;
    const forecastUrl = `https://api.ipma.pt/open-data/forecast/meteorology/cities/daily/${globalIdLocal}.json`;
    const typesUrl = 'https://api.ipma.pt/open-data/weather-type-classe.json';

    async function loadIpmaWeather() {
      try {
        const [forecastRes, typesRes] = await Promise.all([
          fetch(forecastUrl, { signal }),
          fetch(typesUrl, { signal }),
        ]);

        if (!forecastRes.ok) throw new Error(`IPMA forecast HTTP ${forecastRes.status}`);
        if (!typesRes.ok) throw new Error(`IPMA weather types HTTP ${typesRes.status}`);

        const forecastJson = (await forecastRes.json()) as IpmaForecastResponse;
        const typesJson = (await typesRes.json()) as IpmaWeatherTypesResponse;

        const day0 = forecastJson.data?.[0];
        if (!day0?.forecastDate) return;

        const tMax = day0.tMax ? Number(day0.tMax) : undefined;
        const tMin = day0.tMin ? Number(day0.tMin) : undefined;
        const temp = Number.isFinite(tMax) ? tMax : (Number.isFinite(tMin) ? tMin : undefined);
        const tempLabel = Number.isFinite(temp) ? `${Math.round(temp as number)}ºC` : weather.tempLabel;

        const idWeatherType = day0.idWeatherType;
        const descPT = typeof idWeatherType === 'number'
          ? typesJson.data?.find((t) => t.idWeatherType === idWeatherType)?.descWeatherTypePT
          : undefined;

        const icon = pickWeatherEmoji(descPT, idWeatherType);
        const dateLabel = formatPtDateLabel(day0.forecastDate);
        const ariaLabel = descPT ? `Meteorologia: ${descPT}` : 'Meteorologia';

        const title = forecastJson.dataUpdate
          ? `Fonte: IPMA (atualizado em ${forecastJson.dataUpdate})`
          : 'Fonte: IPMA';

        setWeather({ icon, tempLabel, dateLabel, ariaLabel, title });
      } catch (error) {
        // Mantém fallback (evita quebrar a UI caso o IPMA esteja indisponível)
      }
    }

    loadIpmaWeather();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const path = window.location.pathname;
    if (path.startsWith('/graficos')) setActiveTab('stats');
    else if (path.startsWith('/equipamentos')) setActiveTab('devices');
    else setActiveTab('home');
  }, []);

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
            <button className="notif-btn" aria-label="Notificações">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-5-5.9V4a1 1 0 0 0-2 0v1.1A6 6 0 0 0 6 11v3.2c0 .5-.2 1-.6 1.4L4 17h5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M9 17a3 3 0 0 0 6 0" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="notif-badge">2</span>
            </button>
            <button className="avatar-btn" aria-label="Perfil">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-3.314 3.134-6 7-6h2c3.866 0 7 2.686 7 6" />
              </svg>
            </button>
          </div>
        </header>
        <div className="brand-text">
          <h1 className="brand-title">Olá, <b>{customerName}!</b></h1>
        </div>

        <main className="content">
          <section className="summary-card">
            <div className="weather-row">
              <div className="weather-info">
                <span className="weather-icon" role="img" aria-label={weather.ariaLabel} title={weather.title}>{weather.icon}</span>
                <div className="weather-text">
                  <span className="weather-temp">{weather.tempLabel}</span>
                  <span className="weather-date">{weather.dateLabel}</span>
                </div>
              </div>
            </div>
            <div className="summary-metrics">
              {!isApiOnline ? (
                <div className="metric">
                  <p className="metric-value">—</p>
                  <p className="metric-label">API offline (a usar valores de fallback)</p>
                </div>
              ) : null}
              <div className="metric">
                <p className="metric-value">{nowStats ? nowStats.kwhLast24h.toFixed(2) : '—'}</p>
                <p className="metric-label">Consumo (kWh)</p>
              </div>
              <div className="metric">
                <p className="metric-value">{nowStats ? `${nowStats.eurosLast24h.toFixed(2)}€` : '—'}</p>
                <p className="metric-label">Consumo (€)</p>
              </div>
              <div className="metric">
                <div className="metric-value-row">
                  <p className="metric-value">{nowStats ? nowStats.similarKwhLast24h.toFixed(2) : '—'}</p>
                  {nowStats ? (
                    <p className={`metric-delta ${nowStats.similarDeltaPct <= 0 ? 'positive' : 'negative'}`}>
                      {nowStats.similarDeltaPct > 0 ? `+${nowStats.similarDeltaPct.toFixed(0)}%` : `${nowStats.similarDeltaPct.toFixed(0)}%`}
                    </p>
                  ) : null}
                </div>
                <p className="metric-label">Consumo casas semelhantes (kWh)</p>
              </div>
            </div>
          </section>

          <div className="tab-row">
            <button
              className={`tab ${topSection === 'current' ? 'active' : ''}`}
              onClick={() => setTopSection('current')}
              type="button"
            >
              Consumo atual
            </button>
            <button
              className={`tab ${topSection === 'chart' ? 'active' : ''}`}
              onClick={() => setTopSection('chart')}
              type="button"
            >
              Gráfico Consumo
            </button>
          </div>

          {topSection === 'chart' ? (
            <section className="consumption-card" aria-label="Gráfico de consumo">
              <div className="consumption-card-header">
                <div className="consumption-title">{chart.title}</div>
                <div className="segmented" role="tablist" aria-label="Intervalo">
                  <button
                    className={`seg-btn ${chartRange === 'dia' ? 'active' : ''}`}
                    onClick={() => setChartRange('dia')}
                    type="button"
                    role="tab"
                    aria-selected={chartRange === 'dia'}
                  >
                    dia
                  </button>
                  <button
                    className={`seg-btn ${chartRange === 'semana' ? 'active' : ''}`}
                    onClick={() => setChartRange('semana')}
                    type="button"
                    role="tab"
                    aria-selected={chartRange === 'semana'}
                  >
                    semana
                  </button>
                  <button
                    className={`seg-btn ${chartRange === 'mes' ? 'active' : ''}`}
                    onClick={() => setChartRange('mes')}
                    type="button"
                    role="tab"
                    aria-selected={chartRange === 'mes'}
                  >
                    mês
                  </button>
                  <button
                    className="seg-btn"
                    onClick={() => window.location.assign('/graficos')}
                    type="button"
                  >
                    detalhado
                  </button>
                </div>
              </div>

              <div className="bars" aria-label="Barras de consumo">
                {chart.items.map((item) => {
                  const heightPct = Math.max(6, Math.round((item.value / maxValue) * 100));
                  const isPred = item.kind === 'previsto';

                  return (
                    <div key={item.label} className="bar-col">
                      <div className="bar-track" aria-hidden="true">
                        <div
                          className={`bar-fill ${isPred ? 'predicted' : 'consumed'}`}
                          style={{ height: `${heightPct}%` }}
                        >
                          <div className="bar-value">
                            {item.value.toFixed(2)}
                            <span className="bar-unit"> kWh</span>
                          </div>
                        </div>
                      </div>
                      <div className="bar-label">{item.label}</div>
                    </div>
                  );
                })}
              </div>

              <div className="legend" aria-label="Legenda">
                <div className="legend-item">
                  <span className="legend-dot consumed" />
                  Consumido
                </div>
                <div className="legend-item">
                  <span className="legend-dot predicted" />
                  Previsto
                </div>
              </div>
            </section>
          ) : (
            <section className="hero-card">
              <div className="hero-annotations">
                <div className="annotation top">Potência Atual Utilizada <strong>{nowStats ? `${(nowStats.avgWattsLastHour / 1000).toFixed(1)}kW` : '—'}</strong></div>
                <div className="annotation right">Consumo Atual <strong>{nowStats ? `${(nowStats.wattsNow / 1000).toFixed(2)}kW` : '—'}</strong></div>
              </div>
              <img className="hero-house" src={casaImg} alt="Visual da casa" />
            </section>
          )}

          <section className="stats-grid">
            <div className="stat-card glass">
              <p className="stat-title">Consumo mensal até ao momento</p>
              <p className="stat-value">{nowStats ? `${nowStats.monthToDateEuros.toFixed(2)} €` : '—'}</p>
              <p className="stat-delta negative">—</p>
            </div>
            <div className="stat-card glass">
              <p className="stat-title">Consumo mensal previsto</p>
              <p className="stat-value">{nowStats ? `${nowStats.forecastMonthEuros.toFixed(2)} €` : '—'}</p>
              <p className="stat-delta positive">—</p>
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
                  className={`nav-item ${activeTab === item.key ? 'active' : ''}`}
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

export default Dashboard;
