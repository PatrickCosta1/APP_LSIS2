import React, { useEffect, useState } from 'react';
import logoImg from '../assets/images/logo2.png';
import logoEdp from '../assets/images/edp.png';
import logoEndesa from '../assets/images/endesa.png';
import logoGoldEnergy from '../assets/images/goldenergy.png';
import logoIberdrola from '../assets/images/iberdrola.png';

import SettingsDrawer from '../components/SettingsDrawer';
import './Contrato.css';

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

function IconBack() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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

function fmtEur(val: number | null | undefined) {
  if (typeof val !== 'number') return '—';
  return val.toFixed(4) + '€';
}

export default function Contrato() {
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [contract, setContract] = useState<ContractAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customerName, setCustomerName] = useState<string>('Cliente');
  const [userEmail, setUserEmail] = useState<string>('');
  const [userPhotoUrl, setUserPhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    try {
      const id = localStorage.getItem('kynex:customerId');
      setCustomerId(id);
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
        const res = await fetch(`${apiBase}/customers/${customerId}/contract-analysis`);
        if (!res.ok) throw new Error('Failed to load contract');
        const data = await res.json();
        if (!cancelled) {
          setContract(data);
          setLoading(false);
        }
      } catch (err) {
        console.error('Error loading contract:', err);
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [apiBase, customerId]);

  const utility = contract?.current?.utility ?? 'EDP Comercial';
  const tariff = contract?.current?.tariff ?? 'Bi-horário';
  const vazio = contract?.current?.price_vazio_eur_per_kwh ?? 0.14;
  const cheia = contract?.current?.price_cheia_eur_per_kwh ?? 0.19;
  const lastUpdated = contract?.lastUpdated ?? '';
  
  // Preço médio ponderado (assumindo 40% vazio, 60% cheia)
  const avgPrice = (vazio * 0.4 + cheia * 0.6).toFixed(2);

  const recommendations = [
    {
      id: 1,
      provider: 'Goldenergy',
      logo: logoGoldEnergy,
      savings: 145,
      reason: 'Ideal para o seu alto consumo de fim-de-semana',
      priceKwh: 0.14,
      badge: null,
      color: 'cyan'
    },
    {
      id: 2,
      provider: 'Iberdrola',
      logo: logoIberdrola,
      savings: 90,
      reason: 'Tarifa verde adaptada ao seu perfil',
      priceKwh: 0.16,
      badge: 'Energia 100% Verde',
      color: 'green'
    },
    {
      id: 3,
      provider: 'Endesa',
      logo: logoEndesa,
      savings: 65,
      reason: 'Desconto para consumo noturno',
      priceKwh: 0.17,
      badge: null,
      color: 'cyan'
    }
  ];

  return (
    <div className="app-shell">
      <div className="phone-frame contrato-frame">
        <header className="top-bar">
          <div className="brand">
            <button className="brand-logo" type="button" onClick={() => window.location.assign('/dashboard')} aria-label="Ir para Dashboard">
              <img src={logoImg} alt="Kynex" />
            </button>
          </div>
          <div className="contrato-actions">
            <button
              className="contrato-back"
              type="button"
              onClick={() => {
                localStorage.setItem('openSettingsOnReturn', 'true');
                window.history.back();
              }}
              aria-label="Voltar"
            >
              <IconBack />
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

        <main className="content contrato-content">
          <div className="contrato-page-title">O Meu Contrato</div>
          <div className="contrato-subtitle">
            Última atualização: {loading ? '...' : formatPtDateTime(lastUpdated) || 'Hoje, 09:41'}
          </div>

          {loading ? (
            <div className="contrato-loading">
              <div className="spinner"></div>
              <p>A analisar o seu contrato...</p>
            </div>
          ) : (
            <>
              {/* Cartão do Contrato Atual */}
              <div className="contrato-current-card">
                <div className="current-card-header">
                  <div className="provider-logo">
                    <img src={logoEdp} alt={utility} />
                  </div>
                  <div className="provider-info">
                    <div className="provider-name">{utility}</div>
                    <div className="provider-badge">Contrato Atual</div>
                  </div>
                </div>

                <div className="current-card-grid">
                  <div className="info-item">
                    <div className="info-icon">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
                      </svg>
                    </div>
                    <div className="info-content">
                      <div className="info-label">Potência</div>
                      <div className="info-value">6.9 kVA</div>
                    </div>
                  </div>

                  <div className="info-item">
                    <div className="info-icon">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 6v6l4 2" />
                      </svg>
                    </div>
                    <div className="info-content">
                      <div className="info-label">Ciclo</div>
                      <div className="info-value">{tariff}</div>
                    </div>
                  </div>
                </div>

                <div className="current-price-highlight">
                  <div className="price-label">Preço Médio</div>
                  <div className="price-value">{avgPrice}€/kWh</div>
                </div>
              </div>

              {/* Separador com Insights AI */}
              <div className="ai-insights-header">
                <div className="ai-icon">✨</div>
                <div className="ai-text">
                  <div className="ai-title">Insights AI</div>
                  <div className="ai-subtitle">
                    Analisámos o seu padrão de consumo das últimas 4 semanas e encontrámos poupanças:
                  </div>
                </div>
              </div>

              {/* Carrossel de Recomendações */}
              <div className="recommendations-carousel">
                {recommendations.map((rec) => (
                  <div key={rec.id} className={`recommendation-card ${rec.color}`}>
                    <div className="rec-header">
                      <div className="rec-logo">
                        <img src={rec.logo} alt={rec.provider} />
                      </div>
                      <div className="rec-provider">{rec.provider}</div>
                      {rec.badge && <div className="rec-badge">{rec.badge}</div>}
                    </div>

                    <div className="rec-savings">
                      <div className="savings-label">Poupe por ano</div>
                      <div className="savings-value">-{rec.savings}€</div>
                    </div>

                    <div className="rec-reason">{rec.reason}</div>

                    <div className="rec-comparison">
                      <span className="new-price">{rec.priceKwh.toFixed(2)}€</span>
                      <span className="vs">vs</span>
                      <span className="old-price">{avgPrice}€</span>
                    </div>

                    <button className="rec-button">Ver Oferta</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
