import React, { useEffect, useMemo, useState } from 'react';
import logoImg from '../assets/images/logo.png';
import AssistantChatModal from '../components/AssistantChatModal';
import './Dashboard.css';
import './Security.css';

type KynexNodeDevice = {
  applianceId: number;
  name: string;
  state: 'on' | 'off';
};

type KynexNodeAlert = {
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
};

type KynexNodeResponse = {
  customerId: string;
  lastUpdated: string;
  devices: KynexNodeDevice[];
  alert: KynexNodeAlert | null;
};

type ThirdParty = {
  id: string;
  name: string;
  status: 'normal' | 'atencao' | 'risco';
  alertsLast48h: number;
  lastActivity: string | null;
};

type ThirdPartiesResponse = {
  customerId: string;
  lastUpdated: string;
  items: ThirdParty[];
};

type TabKey = 'node' | 'third';

type NavItem = {
  key: 'home' | 'stats' | 'devices' | 'security';
  label: string;
  href: string;
  icon: React.ReactNode;
};

const shieldIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 2L5 6v6c0 5 3.5 9.5 7 10 3.5-0.5 7-5 7-10V6l-7-4z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const navItems: readonly NavItem[] = [
  {
    key: 'home',
    label: 'Home',
    href: '/dashboard',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 9L12 2L21 9V20a2 2 0 0 1-2 2h-5a1 1 0 0 1-1-1v-6H11v6a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V9Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    key: 'stats',
    label: 'Estatísticas',
    href: '/graficos',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 21V10M12 21V3M19 21v-8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
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
    )
  },
  {
    key: 'security',
    label: 'Segurança',
    href: '/seguranca',
    icon: shieldIcon
  }
] as const;

function Security() {
  const [activeTab, setActiveTab] = useState<TabKey>('node');
  const [assistantOpen, setAssistantOpen] = useState(false);

  const [apiBase, setApiBase] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);

  const [node, setNode] = useState<KynexNodeResponse | null>(null);
  const [third, setThird] = useState<ThirdPartiesResponse | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [thirdName, setThirdName] = useState('');
  const [addBusy, setAddBusy] = useState(false);

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
      const token = localStorage.getItem('kynex:authToken');
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

      try {
        const res = await fetch(`${apiBase}/customers/${customerId}/security/kynex-node`, { headers });
        if (!res.ok) throw new Error('kynex-node');
        const json = (await res.json()) as KynexNodeResponse;
        if (!cancelled) setNode(json);
      } catch {
        if (!cancelled) setNode(null);
      }

      try {
        const res = await fetch(`${apiBase}/customers/${customerId}/security/third-parties`, { headers });
        if (!res.ok) throw new Error('third');
        const json = (await res.json()) as ThirdPartiesResponse;
        if (!cancelled) setThird(json);
      } catch {
        if (!cancelled) setThird(null);
      }
    }

    load();
    const id = window.setInterval(load, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [apiBase, customerId]);

  const activeNavKey = useMemo(() => 'security' as const, []);

  async function addThirdParty() {
    const name = thirdName.trim();
    if (!apiBase || !customerId || !name || addBusy) return;

    setAddBusy(true);
    try {
      const token = localStorage.getItem('kynex:authToken');
      const res = await fetch(`${apiBase}/customers/${customerId}/security/third-parties`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ name })
      });
      if (!res.ok) throw new Error('add');
      setThirdName('');
      setAddOpen(false);

      // refresh
      const listRes = await fetch(`${apiBase}/customers/${customerId}/security/third-parties`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      });
      if (listRes.ok) setThird((await listRes.json()) as ThirdPartiesResponse);
    } catch {
      // ignore
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="phone-frame">
        <header className="top-bar">
          <div className="brand">
            <button className="brand-logo" type="button" aria-label="Kynex">
              <img src={logoImg} alt="Kynex" />
            </button>
            <div className="brand-text">
              <p className="brand-eyebrow">Seus associados</p>
              <h1 className="brand-title">Monitorização de risco</h1>
            </div>
          </div>

          <div className="top-actions">
            <button className="notif-btn" aria-label="Notificações" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="notif-badge">2</span>
            </button>
            <button className="avatar-btn" aria-label="Perfil" type="button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="7" r="4" />
                <path d="M5 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2" />
              </svg>
            </button>
          </div>
        </header>

        <main className="content">
          <div className="tab-row" role="tablist" aria-label="Modo de segurança">
            <button
              className={`tab ${activeTab === 'node' ? 'active' : ''}`}
              type="button"
              role="tab"
              aria-selected={activeTab === 'node'}
              onClick={() => setActiveTab('node')}
            >
              Kynex Node
            </button>
            <button
              className={`tab ${activeTab === 'third' ? 'active' : ''}`}
              type="button"
              role="tab"
              aria-selected={activeTab === 'third'}
              onClick={() => setActiveTab('third')}
            >
              Monitorização de terceiros
            </button>
          </div>

          {activeTab === 'node' ? (
            <section className="sec-stack" aria-label="Kynex Node">
              {node?.alert ? (
                <div className="sec-alert" role="alert">
                  <div className="sec-alert-left">{shieldIcon}</div>
                  <div className="sec-alert-copy">
                    <div className="sec-alert-title">{node.alert.title}</div>
                    <div className="sec-alert-sub">{node.alert.message}</div>
                  </div>
                </div>
              ) : null}

              <article className="sec-card" aria-label="Tomadas inteligentes">
                <div className="sec-card-head">
                  <div>
                    <div className="sec-card-title">Kynex Node</div>
                    <div className="sec-card-sub">As tuas tomadas inteligentes</div>
                  </div>
                  <button className="sec-buy" type="button">comprar</button>
                </div>

                <div className="sec-devices" aria-label="Dispositivos">
                  {(node?.devices?.length ? node.devices : []).slice(0, 3).map((d) => (
                    <div key={d.applianceId} className="sec-device">
                      <div className="sec-device-name" title={d.name}>{d.name}</div>
                      <div className={`sec-device-state ${d.state === 'on' ? 'on' : 'off'}`}>{d.state === 'on' ? 'ON' : 'OFF'}</div>
                    </div>
                  ))}

                  {node?.devices?.length ? null : (
                    <div className="sec-empty">Ainda a detetar dispositivos. Aguarde alguns minutos.</div>
                  )}
                </div>
              </article>
            </section>
          ) : (
            <section className="sec-stack" aria-label="Terceiros">
              {third?.items?.length ? (
                third.items.map((p) => (
                  <article key={p.id} className="sec-card sec-person" aria-label={p.name}>
                    <div className="sec-person-top">
                      <div>
                        <div className="sec-person-name">{p.name}</div>
                        <div className="sec-person-status">
                          <span className={`sec-dot ${p.status}`} aria-hidden="true" />
                          {p.status === 'normal' ? 'Rotina Normal' : p.status === 'atencao' ? 'Atenção' : 'Risco'}
                        </div>
                      </div>
                    </div>

                    <div className="sec-person-metrics">
                      <div className="sec-person-metric">
                        <div className="sec-person-metric-k">Alertas:</div>
                        <div className="sec-person-metric-v">{p.alertsLast48h} nas últimas 48 horas</div>
                      </div>
                      <div className="sec-person-metric">
                        <div className="sec-person-metric-k">Última atividade:</div>
                        <div className="sec-person-metric-v">{p.lastActivity ? new Date(p.lastActivity).toLocaleString('pt-PT') : '—'}</div>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <article className="sec-card" aria-label="Adicionar terceiro">
                  <div className="sec-empty-title">Sem associados</div>
                  <div className="sec-empty-sub">Adicione um familiar para começar a monitorização.</div>

                  {!addOpen ? (
                    <button className="sec-cta" type="button" onClick={() => setAddOpen(true)}>
                      + Adicionar terceiro
                    </button>
                  ) : (
                    <div className="sec-add">
                      <input
                        className="sec-input"
                        value={thirdName}
                        onChange={(e) => setThirdName(e.target.value)}
                        placeholder="Nome (ex.: Avó Maria)"
                        aria-label="Nome do terceiro"
                      />
                      <div className="sec-add-actions">
                        <button className="sec-cta ghost" type="button" onClick={() => { setAddOpen(false); setThirdName(''); }} disabled={addBusy}>
                          Cancelar
                        </button>
                        <button className="sec-cta" type="button" onClick={addThirdParty} disabled={addBusy || !thirdName.trim()}>
                          {addBusy ? 'A adicionar…' : 'Adicionar'}
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              )}
            </section>
          )}
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
                  className={`nav-item ${activeNavKey === item.key ? 'active' : ''}`}
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

        <AssistantChatModal open={assistantOpen} onClose={() => setAssistantOpen(false)} apiBase={apiBase} customerId={customerId} />
      </div>
    </div>
  );
}

export default Security;
