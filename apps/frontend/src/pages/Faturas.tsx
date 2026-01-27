import React, { useEffect, useState } from 'react';
import logoImg from '../assets/images/logo2.png';
import SettingsDrawer from '../components/SettingsDrawer';
import './Faturas.css';

function IconBack() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function IconDocument() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
    </svg>
  );
}

type Invoice = {
  id: string;
  filename: string;
  uploaded_at: string;
  valor_pagar_eur?: number;
  potencia_contratada_kva?: number;
  termo_energia_eur?: number;
  termo_potencia_eur?: number;
  analysis?: {
    consumption_kwh_year: number;
    current_cost_year_eur: number;
    best_cost_year_eur: number;
    savings_year_eur: number;
    top: Array<{ comercializador: string; nome_proposta: string; cost_year_eur: number; savings_year_eur: number }>;
  };
};

export default function Faturas() {
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customerName, setCustomerName] = useState<string>('Cliente');
  const [userEmail, setUserEmail] = useState<string>('');
  const [userPhotoUrl, setUserPhotoUrl] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

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
    const apiBases = [(import.meta as any).env?.VITE_API_BASE as string | undefined, 'http://localhost:4100'].filter(Boolean) as string[];
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

    async function loadInvoices() {
      setLoading(true);
      try {
        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(`${apiBase}/customers/${customerId}/invoices`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('invoices');
        const json = (await res.json()) as { items: Invoice[] };
        if (!cancelled) setInvoices(Array.isArray(json.items) ? json.items : []);
      } catch (err) {
        console.error('Error loading invoices:', err);
        if (!cancelled) setInvoices([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadInvoices();
    return () => {
      cancelled = true;
    };
  }, [apiBase, customerId]);

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

  const handleUploadClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (!apiBase || !customerId) return;

      try {
        setUploading(true);
        const token = localStorage.getItem('kynex:authToken');

        const form = new FormData();
        form.append('file', file);

        const res = await fetch(`${apiBase}/customers/${customerId}/invoices`, {
          method: 'POST',
          body: form,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('upload');

        // recarrega lista
        const listRes = await fetch(`${apiBase}/customers/${customerId}/invoices`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (listRes.ok) {
          const json = (await listRes.json()) as { items: Invoice[] };
          setInvoices(Array.isArray(json.items) ? json.items : []);
        }
      } catch (err) {
        console.error('Upload failed:', err);
      } finally {
        setUploading(false);
      }
    };
    input.click();
  };

  const getStatusBadgeClass = (invoice: Invoice) => {
    const s = invoice.analysis?.savings_year_eur;
    if (typeof s !== 'number') return 'badge-due';
    if (s > 0.5) return 'badge-due';
    return 'badge-warning';
  };

  const getStatusText = (invoice: Invoice) => {
    const s = invoice.analysis?.savings_year_eur;
    if (typeof s !== 'number') return 'Sem análise';
    if (s > 0.5) return `✅ Poupa ${Math.round(s)}€/ano`;
    return 'Sem poupança';
  };

  const fmtUploaded = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' });
  };

  return (
    <div className="app-shell">
      <div className="phone-frame faturas-frame">
        <header className="top-bar">
          <div className="brand">
            <button className="brand-logo" type="button" onClick={() => window.location.assign('/dashboard')} aria-label="Ir para Dashboard">
              <img src={logoImg} alt="Kynex" />
            </button>
          </div>
          <div className="faturas-actions">
            <button
              className="faturas-back"
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

        <main className="content faturas-content">
          <div className="faturas-page-title">Arquivo de Faturas</div>
          <div className="faturas-subtitle">Histórico e validação</div>

          {/* Hero Section - Upload */}
          <div className="upload-hero" onClick={handleUploadClick}>
            <div className="upload-icon-wrapper">
              <IconUpload />
            </div>
            <div className="upload-text">
              <div className="upload-main-text">Carregar Nova Fatura</div>
              <div className="upload-sub-text">{uploading ? 'A enviar…' : 'PDF ou Imagem'}</div>
            </div>
          </div>

          {/* Lista de Histórico */}
          <div className="invoices-section">
            <div className="section-title">Recentes</div>
            
            <div className="invoices-list">
              {loading && <div className="invoice-item">A carregar…</div>}
              {!loading && invoices.length === 0 && <div className="invoice-item">Sem faturas ainda</div>}
              {!loading && invoices.map((invoice) => (
                <div key={invoice.id} className="invoice-item">
                  <div className="invoice-icon">
                    <IconBolt />
                  </div>
                  
                  <div className="invoice-info">
                    <div className="invoice-header">
                      <span className="invoice-reference">{invoice.filename || 'Fatura'}</span>
                      {invoice.analysis && <span className="ai-badge">✨</span>}
                    </div>
                    <div className="invoice-details">
                      <span className="invoice-provider">{invoice.analysis?.top?.[0]?.comercializador ?? '—'}</span>
                      <span className="invoice-separator">•</span>
                      <span className="invoice-date">{fmtUploaded(invoice.uploaded_at)}</span>
                    </div>
                  </div>

                  <div className="invoice-right">
                    <div className="invoice-amount">{typeof invoice.valor_pagar_eur === 'number' ? invoice.valor_pagar_eur.toFixed(2) + '€' : '—'}</div>
                    <div className={`invoice-badge ${getStatusBadgeClass(invoice)}`}>
                      {getStatusText(invoice)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
