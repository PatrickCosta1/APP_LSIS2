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
  reference: string;
  date: string;
  amount: number;
  dueDate: Date;
  provider: string;
  aiAnalyzed: boolean;
};

export default function Faturas() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customerName, setCustomerName] = useState<string>('Cliente');
  const [userEmail, setUserEmail] = useState<string>('');
  const [userPhotoUrl, setUserPhotoUrl] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);

  // Dados de exemplo
  const [invoices] = useState<Invoice[]>([
    {
      id: '1',
      reference: 'Fatura #2024-02',
      date: '12 Fev',
      amount: 45.20,
      dueDate: new Date('2026-02-27'),
      provider: 'EDP Comercial',
      aiAnalyzed: true
    },
    {
      id: '2',
      reference: 'Fatura #2024-01',
      date: '10 Jan',
      amount: 38.90,
      dueDate: new Date('2026-01-26'), // 2 dias - warning
      provider: 'EDP Comercial',
      aiAnalyzed: true
    },
    {
      id: '3',
      reference: 'Fatura #2023-12',
      date: '08 Dez',
      amount: 52.15,
      dueDate: new Date('2025-12-23'), // ultrapassada
      provider: 'EDP Comercial',
      aiAnalyzed: true
    },
    {
      id: '4',
      reference: 'Fatura #2023-11',
      date: '05 Nov',
      amount: 41.30,
      dueDate: new Date('2025-11-20'), // ultrapassada
      provider: 'EDP Comercial',
      aiAnalyzed: true
    }
  ]);

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

  const handleUploadClick = () => {
    // TODO: Implementar lógica de upload
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        console.log('Ficheiro selecionado:', file.name);
        // Aqui seria feito o upload para o backend
      }
    };
    input.click();
  };

  const getInvoiceStatus = (dueDate: Date): 'overdue' | 'warning' | 'normal' => {
    const now = new Date();
    const diffTime = dueDate.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return 'overdue'; // Ultrapassada
    } else if (diffDays <= 3) {
      return 'warning'; // Últimos 3 dias
    } else {
      return 'normal'; // Ainda tem tempo
    }
  };

  const getStatusBadgeClass = (status: 'overdue' | 'warning' | 'normal') => {
    switch (status) {
      case 'overdue':
        return 'badge-overdue';
      case 'warning':
        return 'badge-warning';
      case 'normal':
        return 'badge-due';
    }
  };

  const getStatusText = (invoice: Invoice) => {
    const status = getInvoiceStatus(invoice.dueDate);
    
    if (status === 'overdue') {
      return 'Ultrapassada';
    } else if (status === 'warning') {
      const diffTime = invoice.dueDate.getTime() - new Date().getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      return `⚠️ ${diffDays} ${diffDays === 1 ? 'dia' : 'dias'}`;
    } else {
      const formatted = invoice.dueDate.toLocaleDateString('pt-PT', { day: 'numeric', month: 'short' });
      return `Até ${formatted}`;
    }
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
              <div className="upload-sub-text">PDF ou Imagem</div>
            </div>
          </div>

          {/* Lista de Histórico */}
          <div className="invoices-section">
            <div className="section-title">Recentes</div>
            
            <div className="invoices-list">
              {invoices.map((invoice) => (
                <div key={invoice.id} className="invoice-item">
                  <div className="invoice-icon">
                    <IconBolt />
                  </div>
                  
                  <div className="invoice-info">
                    <div className="invoice-header">
                      <span className="invoice-reference">{invoice.reference}</span>
                      {invoice.aiAnalyzed && <span className="ai-badge">✨</span>}
                    </div>
                    <div className="invoice-details">
                      <span className="invoice-provider">{invoice.provider}</span>
                      <span className="invoice-separator">•</span>
                      <span className="invoice-date">{invoice.date}</span>
                    </div>
                  </div>

                  <div className="invoice-right">
                    <div className="invoice-amount">{invoice.amount.toFixed(2)}€</div>
                    <div className={`invoice-badge ${getStatusBadgeClass(getInvoiceStatus(invoice.dueDate))}`}>
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
