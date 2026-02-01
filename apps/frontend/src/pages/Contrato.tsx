import React, { useEffect, useState } from 'react';
import logoImg from '../assets/images/logo2.png';
import logoEdp from '../assets/images/edp.png';
import logoEndesa from '../assets/images/endesa.png';
import logoGoldEnergy from '../assets/images/goldenergy.png';
import logoIberdrola from '../assets/images/iberdrola.png';
import logoSU from '../assets/images/su-eletricidade.png';

import SettingsDrawer from '../components/SettingsDrawer';
import './Contrato.css';

type ContractAnalysisResponse = {
  customerId: string;
  lastUpdated: string;
  contractedPowerKva: number;
  avgPriceEurPerKwh: number;
  fixedDailyFeeEur: number;
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
  marketComparison?: InvoiceSummary['analysis'] | null;
};

type InvoiceSummary = {
  id: string;
  filename: string;
  uploaded_at: string;
  valor_pagar_eur?: number;
  potencia_contratada_kva?: number;
  utility_guess?: string;
  analysis?: { 
    consumption_kwh_year: number;
    current_cost_year_eur: number;
    best_cost_year_eur: number;
    savings_year_eur: number;
    top: Array<{ comercializador: string; nome_proposta: string; cost_year_eur: number; savings_year_eur: number }>;
  };
};

function IconBack() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function fmtEur(val: number | null | undefined) {
  if (typeof val !== 'number') return '—';
  return val.toFixed(4) + '€';
}

function fmtEur0(val: number | null | undefined) {
  if (typeof val !== 'number' || Number.isNaN(val)) return '—';
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(val);
}

function fmtEurSigned0(val: number | null | undefined) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return '—';
  const abs = Math.abs(val);
  const formatted = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(abs);
  if (val > 0) return `-${formatted}`; // poupança: mostrar '-'
  if (val < 0) return `+${formatted}`; // mais caro: mostrar '+'
  return formatted;
}

function fmtKwhYear(val: number | null | undefined) {
  if (typeof val !== 'number' || Number.isNaN(val)) return '—';
  return new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 0 }).format(Math.round(val)) + ' kWh/ano';
}

function pickUtilityLogo(utility: string) {
  const u = String(utility ?? '').toLowerCase();
  if (u.includes('endesa')) return logoEndesa;
  if (u.includes('iberdrola')) return logoIberdrola;
  if (u.includes('gold')) return logoGoldEnergy;
  if (u.includes('edp')) return logoEdp;
  if (u.includes('su')) return logoSU;
  return logoImg;
}

function displayProviderName(raw: string) {
  const s = String(raw ?? '').trim();
  const u = s.toLowerCase();
  if (!u) return '—';
  if (u === 'gold') return 'Goldenergy';
  if (u === 'edpc') return 'EDP';
  if (u.includes('gold')) return 'Goldenergy';
  if (u.includes('iberdrola')) return 'Iberdrola';
  if (u.includes('endesa')) return 'Endesa';
  if (u.includes('su')) return 'SU Eletricidade';
  if (u.includes('edp')) return 'EDP';
  return s;
}

export default function Contrato() {
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [contract, setContract] = useState<ContractAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [latestInvoice, setLatestInvoice] = useState<InvoiceSummary | null>(null);
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
      setLoading(true);
      try {
        const token = localStorage.getItem('kynex:authToken');
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

        const res = await fetch(`${apiBase}/customers/${customerId}/contract/analysis`, { headers });
        if (!res.ok) throw new Error('Failed to load contract');
        const data = await res.json();
        if (!cancelled) {
          setContract(data);
        }

        const invRes = await fetch(`${apiBase}/customers/${customerId}/invoices`, { headers });
        if (invRes.ok) {
          const json = (await invRes.json()) as { items: InvoiceSummary[] };
          const first = Array.isArray(json.items) ? json.items[0] : null;
          if (!cancelled) setLatestInvoice(first ?? null);
        }
      } catch (err) {
        console.error('Error loading contract:', err);
        if (!cancelled) {
          setContract(null);
          setLatestInvoice(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [apiBase, customerId]);

  const utility = contract?.current?.utility ?? '—';
  const displayUtility = latestInvoice?.utility_guess ?? utility;
  const tariff = contract?.current?.tariff ?? '—';
  const vazio = contract?.current?.price_vazio_eur_per_kwh ?? 0;
  const cheia = contract?.current?.price_cheia_eur_per_kwh ?? 0;

  const offpeakFrac = Math.max(0, Math.min(1, (contract?.offpeakPct ?? 0) / 100));
  const computedAvg = tariff.toLowerCase().includes('bi') ? vazio * offpeakFrac + cheia * (1 - offpeakFrac) : cheia;
  const avgPrice = (typeof contract?.avgPriceEurPerKwh === 'number' ? contract.avgPriceEurPerKwh : computedAvg).toFixed(4);

  const contractedPower =
    (typeof latestInvoice?.potencia_contratada_kva === 'number' ? latestInvoice.potencia_contratada_kva : null) ??
    (typeof contract?.contractedPowerKva === 'number' ? contract.contractedPowerKva : null);

  const suggestionMsg = contract?.suggestion?.message ?? '';
  const simpleTotal = contract?.suggestion?.compare?.simples?.estimatedMonth?.total ?? null;
  const biTotal = contract?.suggestion?.compare?.bihorario?.estimatedMonth?.total ?? null;
  const suggestedTariff = contract?.suggestion?.tariff ?? null;

  // IMPORTANTE: comparação deve ser estável e baseada na última fatura (não telemetria)
  const market = latestInvoice?.analysis ?? null;
  const bestOffer = Array.isArray(market?.top) && market!.top.length > 0 ? market!.top[0] : null;
  const savingsYear = typeof market?.savings_year_eur === 'number' && Number.isFinite(market!.savings_year_eur) ? market!.savings_year_eur : null;
  const hasPositiveSavings = typeof bestOffer?.savings_year_eur === 'number' && bestOffer.savings_year_eur > 0.5;
  const hasNegativeSavings = typeof savingsYear === 'number' && savingsYear < -0.5;

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
                    <img src={pickUtilityLogo(displayUtility)} alt={displayUtility} />
                  </div>
                  <div className="provider-info">
                    <div className="provider-name">{displayUtility}</div>
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
                      <div className="info-value">{typeof contractedPower === 'number' ? contractedPower.toFixed(1) + ' kVA' : '—'}</div>
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

              {/* Comparação de Mercado */}
              <div className="ai-insights-header" style={{ marginTop: -8 }}>
                <div className="ai-text">
                  <div className="ai-title">Comparação de Mercado</div>
                  <div className="ai-subtitle">Comparação baseada na sua última fatura e nos preços de tarifa que definimos.</div>
                </div>
              </div>

              <div className="contrato-current-card market-card" style={{ marginBottom: 28 }}>
                <div className="current-card-header">
                  <div className="provider-logo" aria-hidden="true"></div>
                  <div className="provider-info">
                    <div className="provider-name">Mercado</div>
                    <div className="provider-badge">Comparação</div>
                  </div>
                </div>

                {market ? (
                  <>
                    <div className="current-price-highlight market-highlight">
                      <div className="price-label">Poupança potencial</div>
                      <div className={`price-value ${hasPositiveSavings ? 'positive' : hasNegativeSavings ? 'negative' : ''}`}>
                        {hasPositiveSavings
                          ? `-${fmtEur0(savingsYear)} / ano`
                          : hasNegativeSavings
                            ? `Mais caro +${fmtEur0(Math.abs(savingsYear!))} / ano`
                            : 'Sem diferença relevante'}
                      </div>
                      {hasPositiveSavings ? (
                        <div className="market-best-offer">
                          Melhor opção: <strong>{displayProviderName(bestOffer.comercializador)}</strong>
                        </div>
                      ) : null}
                    </div>

                    {Array.isArray(market.top) && market.top.length > 0 ? (
                      <div className="market-top-list" aria-label="Top ofertas">
                        {market.top.slice(0, 5).map((o, idx) => {
                          const provider = displayProviderName(o.comercializador);
                          const logo = pickUtilityLogo(provider);
                          const sRaw = typeof o.savings_year_eur === 'number' ? o.savings_year_eur : null;
                          const s = typeof sRaw === 'number' && Number.isFinite(sRaw) ? sRaw : null;
                          const cls = s !== null && s > 0.1 ? 'positive' : s !== null && s < -0.1 ? 'negative' : '';
                          return (
                            <div className="market-offer-row" key={`${o.comercializador}-${o.nome_proposta}-${idx}`}>
                              <div className="market-offer-logo" aria-hidden="true">
                                <img src={logo} alt="" />
                              </div>
                              <div className="market-offer-main">
                                <div className="market-offer-provider">{provider}</div>
                                <div className="market-offer-name">{o.nome_proposta}</div>
                              </div>
                              <div className={`market-offer-savings ${cls}`}>{s !== null ? `${fmtEurSigned0(s)} / ano` : '—'}</div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="market-empty">Sem ofertas disponíveis para comparação.</div>
                    )}
                  </>
                ) : (
                  <div className="market-empty">Carregue uma fatura para gerar a comparação.</div>
                )}
              </div>

              {/* Sugestão (dados reais do backend) */}
              <div className="ai-insights-header">
                <div className="ai-icon">✨</div>
                <div className="ai-text">
                  <div className="ai-title">Sugestão de Tarifa</div>
                  <div className="ai-subtitle">{suggestionMsg || '—'}</div>
                </div>
              </div>

              <div className="contrato-current-card" style={{ marginTop: 12 }}>
                <div className="current-card-grid">
                  <div className="info-item">
                    <div className="info-content">
                      <div className="info-label">Simples (estim.)</div>
                      <div className="info-value">{typeof simpleTotal === 'number' ? `${Math.round(simpleTotal)}€ / mês` : '—'}</div>
                    </div>
                  </div>
                  <div className="info-item">
                    <div className="info-content">
                      <div className="info-label">Bi-horário (estim.)</div>
                      <div className="info-value">{typeof biTotal === 'number' ? `${Math.round(biTotal)}€ / mês` : '—'}</div>
                    </div>
                  </div>
                </div>
                <div className="current-price-highlight">
                  <div className="price-label">Recomendação</div>
                  <div className="price-value">{suggestedTariff ? String(suggestedTariff) : '—'}</div>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
