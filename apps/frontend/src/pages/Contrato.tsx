import React, { useEffect, useState } from 'react';
import logoImg from '../assets/images/logo.png';
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
  const vazio = contract?.current?.price_vazio_eur_per_kwh ?? 0;
  const cheia = contract?.current?.price_cheia_eur_per_kwh ?? 0;
  const fixed = contract?.current?.fixed_daily_fee_eur ?? 0;
  const lastUpdated = contract?.lastUpdated ?? '';

  return (
    <div className="app-shell">
      <div className="phone-frame contrato-frame">
        <header className="top-bar">
          <div className="brand">
            <div className="brand-logo">
              <img src={logoImg} alt="Kynex" />
            </div>
          </div>
          <div className="contrato-actions">
            <button
              className="contrato-back"
              type="button"
              onClick={() => window.location.assign('/dashboard')}
              aria-label="Voltar"
            >
              <IconBack />
            </button>
            <button
              className="avatar-btn"
              aria-label="Perfil"
              type="button"
              onClick={() => setSettingsOpen(true)}
              style={{ marginLeft: 'auto' }}
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

        <div className="contrato-title">Contrato</div>

        <main className="content">
          {loading ? (
            <div className="contrato-loading">A carregar informações do contrato...</div>
          ) : (
            <div className="contrato-card">
              <div className="contrato-header">
                <div className="contrato-provider">
                  <div className="contrato-provider-label">Comercializador</div>
                  <div className="contrato-provider-name">{utility}</div>
                </div>
                <div className="contrato-date">
                  <div className="contrato-date-label">Última atualização</div>
                  <div className="contrato-date-value">{formatPtDateTime(lastUpdated)}</div>
                </div>
              </div>

              <div className="contrato-divider" />

              <div className="contrato-details">
                <div className="contrato-detail-section">
                  <div className="contrato-section-title">Tarifário</div>
                  <div className="contrato-section-value">{tariff}</div>
                </div>

                <div className="contrato-detail-section">
                  <div className="contrato-section-title">Preços por kWh</div>
                  <div className="contrato-prices">
                    <div className="contrato-price-item">
                      <span className="contrato-price-label">Vazio:</span>
                      <span className="contrato-price-value">{fmtEur(vazio)}</span>
                    </div>
                    <div className="contrato-price-item">
                      <span className="contrato-price-label">Cheia:</span>
                      <span className="contrato-price-value">{fmtEur(cheia)}</span>
                    </div>
                  </div>
                </div>

                <div className="contrato-detail-section">
                  <div className="contrato-section-title">Termo Fixo (Potência/dia)</div>
                  <div className="contrato-section-value">{fmtEur(fixed)}</div>
                </div>
              </div>

              <div className="contrato-footer">
                <div className="contrato-info-icon">ℹ️</div>
                <div className="contrato-info-text">
                  Estes valores refletem o seu contrato atual. Para ver ofertas e simulações, visite a página de Estatísticas.
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
