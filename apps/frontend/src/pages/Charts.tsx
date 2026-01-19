import React, { useEffect, useMemo, useRef, useState } from 'react';
import logoImg from '../assets/images/logo.png';
import './Dashboard.css';
import './Charts.css';

type RangeKey = 'semana' | 'mes';

type ConsumptionSeriesResponse = {
  range: RangeKey;
  labels: string[];
  values: number[];
  lastUpdated: string;
};

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

function Charts() {
  const [range, setRange] = useState<RangeKey>('semana');
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement | null>(null);

  const [apiBase, setApiBase] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [series, setSeries] = useState<ConsumptionSeriesResponse>({ range: 'semana', labels: [], values: [], lastUpdated: '' });

  const [power, setPower] = useState<PowerSuggestionResponse | null>(null);
  const [powerModalOpen, setPowerModalOpen] = useState(false);

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

    async function loadSeries() {
      try {
        const res = await fetch(`${apiBase}/customers/${customerId}/analytics/consumption?range=${encodeURIComponent(range)}`);
        if (!res.ok) throw new Error('series');
        const json = (await res.json()) as ConsumptionSeriesResponse;
        if (!cancelled) setSeries(json);
      } catch {
        if (!cancelled) setSeries({ range, labels: [], values: [], lastUpdated: '' });
      }
    }

    async function loadPower() {
      try {
        const res = await fetch(`${apiBase}/customers/${customerId}/power/suggestion`);
        if (!res.ok) throw new Error('power');
        const json = (await res.json()) as PowerSuggestionResponse;
        if (!cancelled) setPower(json);
      } catch {
        if (!cancelled) setPower(null);
      }
    }

    loadSeries();
    loadPower();

    const id = window.setInterval(() => {
      loadSeries();
      loadPower();
    }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [apiBase, customerId, range]);

  useEffect(() => {
    if (!powerModalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setPowerModalOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [powerModalOpen]);

  const powerAlternatives = (power?.alternatives ?? []).slice().sort((a, b) => a.score - b.score);
  const currentAlt = powerAlternatives.find((a) => Math.abs(a.kva - (power?.contractedKva ?? 0)) < 1e-6);
  const bestAlt = powerAlternatives[0];
  const savingsMonth = (typeof power?.savingsMonth === 'number' ? power.savingsMonth : null);

  const labels = series.labels.length
    ? series.labels
    : (range === 'semana' ? ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'] : Array.from({ length: 30 }, (_, i) => `${i + 1}`));
  const values = series.values.length ? series.values : Array.from({ length: labels.length }, () => 0);

  const monthTicks = useMemo(() => {
    const last = labels[labels.length - 1] ?? '30';
    const base = ['1', '5', '10', '15', '20', '25', last];
    return Array.from(new Set(base));
  }, [labels]);

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

        <div className="brand-text ana-brand-text">
          <h1 className="brand-title">Os meus <b>consumos</b></h1>
        </div>

        <main className="content">
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
                    className={`seg-btn ${range === 'semana' ? 'active' : ''}`}
                    onClick={() => setRange('semana')}
                    type="button"
                    role="tab"
                    aria-selected={range === 'semana'}
                  >
                    Semanal
                  </button>
                  <button
                    className={`seg-btn ${range === 'mes' ? 'active' : ''}`}
                    onClick={() => setRange('mes')}
                    type="button"
                    role="tab"
                    aria-selected={range === 'mes'}
                  >
                    Mensal
                  </button>
                </div>

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
                {range === 'semana'
                  ? labels.map((l) => (
                      <span key={l} className="ana-x-tick">{l}</span>
                    ))
                    : monthTicks.map((l) => (
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

            <article className="ana-mini-card" aria-label="Eficiência Horária">
              <div className="ana-mini-head">
                <div className="ana-mini-title">Eficiência Horária</div>
                <button className="ana-mini-help" type="button" aria-label="Ajuda">?</button>
              </div>

              <div className="ana-mini-body">
                <div className="ana-eff">
                  <div className="ana-eff-gauge" aria-label="Eficiência 65%">
                    <div className="ana-eff-gauge-inner">
                      <div className="ana-eff-gauge-value">65%</div>
                    </div>
                  </div>

                  <div className="ana-eff-copy">
                    <div className="ana-eff-note">Aproveitou bem a noite, mas pode melhorar.</div>
                    <button className="ana-eff-cta" type="button">
                      <span className="ana-eff-cta-col">
                        <strong>Movimentos Inteligentes🧠</strong>
                        <span className="ana-eff-save">Poupe até ~6€</span>
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
              <button className="ana-contract-cta" type="button">
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
                      <span className="ana-contract-pill-val">0,1345€</span>
                    </div>
                    <div className="ana-contract-pill">
                      <span className="ana-contract-pill-key">Cheia:</span>
                      <span className="ana-contract-pill-val">0,2156€</span>
                    </div>
                  </div>

                  <div className="ana-contract-pill-group">
                    <div className="ana-contract-pill-label">Potência/dia</div>
                    <div className="ana-contract-pill big">
                      <span className="ana-contract-pill-val">0,3174€</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="ana-contract-right" aria-label="Ofertas">
                <div className="ana-contract-right-text">
                  Existem ofertas mais vantajosas no mercado!
                </div>

                <div className="ana-contract-save">Poupe até ~60€/ano</div>

                <button className="ana-contract-offers" type="button">
                  Ver Ofertas
                  <span className="ana-contract-offers-icon" aria-hidden="true">↗</span>
                </button>
              </div>
            </div>
          </section>

          <section className="ana-insights" aria-label="Insights">
            <article className="ana-insight-card" aria-label="Insight potência">
              <div className="ana-insight-icon" aria-hidden="true">✦</div>
              <div className="ana-insight-text">
                O seu pico máximo este ano foi de <strong>{yearlyPeakKva.toFixed(1)}kVA</strong>, mas paga por{' '}
                <strong>{contractedKva.toFixed(1)}kVA</strong>. Baixe para <strong>{suggestedIdealKva.toFixed(1)} kVA</strong> sem perder conforto.
              </div>
            </article>

            <article className="ana-insight-card" aria-label="Insight lavagem">
              <div className="ana-insight-icon" aria-hidden="true">✦</div>
              <div className="ana-insight-text">
                Detetámos 4 ciclos de lavagem às 19h00 (Ponta). Se agendar para depois das 22h00 (Vazio), a eletricidade é 40% mais barata.
              </div>
            </article>

            <article className="ana-insight-card" aria-label="Insight standby">
              <div className="ana-insight-icon" aria-hidden="true">✦</div>
              <div className="ana-insight-text">
                A sua casa gasta 250W constantes às 4h da manhã. Verifique se a TV, a Box ou o PC ficaram em stand-by.
              </div>
            </article>
          </section>
        </main>

        <div className="bottom-nav-wrapper">
          <div className="bottom-nav-container">
            <button className="assistant-cta" aria-label="Assistente IA" type="button">
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
    </div>
  );
}

export default Charts;
