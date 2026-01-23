import React, { useMemo } from 'react';
import logoImg from '../assets/images/logo.png';
import './SettingsGeneric.css';

type PageDef = { prefix: string; title: string };

const pages: PageDef[] = [
  { prefix: '/perfil', title: 'Editar Perfil' },
  { prefix: '/loja', title: 'Loja Kynex' },
  { prefix: '/plano', title: 'Plano & Subscrição' },
  { prefix: '/faturas', title: 'Faturas' },
  { prefix: '/contrato', title: 'Contrato' },
  { prefix: '/relatorios', title: 'Relatórios' },
  { prefix: '/tema', title: 'Tema' },
  { prefix: '/sobre-nos', title: 'Sobre Nós' },
  { prefix: '/definicoes', title: 'Definições' },
];

function IconBack() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function SettingsGeneric() {
  const path = window.location.pathname;

  const title = useMemo(() => {
    const match = pages.find((p) => path.startsWith(p.prefix));
    return match?.title ?? 'Configurações';
  }, [path]);

  return (
    <div className="app-shell">
      <div className="phone-frame sg-frame">
        <header className="top-bar">
          <div className="brand">
            <div className="brand-logo">
              <img src={logoImg} alt="Kynex" />
            </div>
          </div>
          <div className="sg-actions">
            <button className="sg-back" type="button" onClick={() => window.location.assign('/dashboard')} aria-label="Voltar">
              <IconBack />
            </button>
          </div>
        </header>

        <div className="sg-title">{title}</div>
        <div className="sg-card">
          <div className="sg-note">Página em construção.</div>
          <div className="sg-sub">Já está ligada a navegação a partir do menu lateral.</div>
        </div>
      </div>
    </div>
  );
}
