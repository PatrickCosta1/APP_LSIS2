import React, { useEffect, useMemo } from 'react';
import './SettingsDrawer.css';

type DrawerUser = {
  name: string;
  email: string;
  photoUrl?: string | null;
};

type SettingsDrawerProps = {
  open: boolean;
  user: DrawerUser;
  onClose: () => void;
};

function safeInitials(name: string) {
  const cleaned = String(name ?? '').trim();
  if (!cleaned) return 'U';
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? 'U';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

function IconChevron() {
  return (
    <svg className="sd-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconBack() {
  return (
    <svg className="sd-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function SettingsDrawer({ open, user, onClose }: SettingsDrawerProps) {
  // UX: quando o drawer está aberto, evita scroll no body.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // UX: permitir fechar com ESC.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const initials = useMemo(() => safeInitials(user.name), [user.name]);

  function goTo(path: string) {
    // Projeto não usa router; navegação simples.
    window.location.assign(path);
  }

  function logout() {
    try {
      localStorage.removeItem('kynex:authToken');
      localStorage.removeItem('kynex:customerId');
      // Mantemos onboarding salvo (perfil) por UX; remove se quiser “logout total”.
    } catch {
      // ignore
    }
    window.location.assign('/login');
  }

  return (
    <div className={`sd-overlay ${open ? 'open' : ''}`} aria-hidden={!open}
      onMouseDown={(e) => {
        // Fecha ao clicar fora (overlay). Mantém a seta como ação principal.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        className={`sd-drawer ${open ? 'open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
      >
        <div className="sd-top">
          <button className="sd-back" type="button" onClick={onClose} aria-label="Voltar">
            <IconBack />
          </button>
          <div className="sd-title">Configurações</div>
          <div className="sd-top-spacer" aria-hidden="true" />
        </div>

        {/* Espaçamento vertical de ~5mm abaixo do topo */}
        <div className="sd-gap" aria-hidden="true" />

        <div className="sd-section">
          <div className="sd-section-title">Utilizador</div>
          <button className="sd-card" type="button" onClick={() => goTo('/perfil')} aria-label="Editar perfil">
            <div className="sd-user-row">
              <div className="sd-avatar" aria-hidden="true">
                {user.photoUrl ? (
                  <img className="sd-avatar-img" src={user.photoUrl} alt="" />
                ) : (
                  <div className="sd-avatar-fallback">{initials}</div>
                )}
              </div>
              <div className="sd-user-text">
                <div className="sd-user-name">{user.name || 'Utilizador'}</div>
                <div className="sd-user-email">{user.email || '—'}</div>
              </div>
              <div className="sd-right">
                <IconChevron />
              </div>
            </div>
          </button>
        </div>

        <div className="sd-section">
          <div className="sd-section-title">Loja &amp; Planos</div>
          <div className="sd-card" role="group" aria-label="Loja e Planos">
            <button className="sd-row" type="button" onClick={() => goTo('/loja')}>
              <IconChevron />
              <span className="sd-row-text">Loja Kynex</span>
            </button>
            <button className="sd-row" type="button" onClick={() => goTo('/plano')}>
              <IconChevron />
              <span className="sd-row-text">Plano &amp; Subscrição</span>
            </button>
          </div>
        </div>

        <div className="sd-section">
          <div className="sd-section-title">Energia e Custos</div>
          <div className="sd-card" role="group" aria-label="Energia e Custos">
            <button className="sd-row" type="button" onClick={() => goTo('/faturas')}>
              <IconChevron />
              <span className="sd-row-text">Faturas</span>
            </button>
            <button className="sd-row" type="button" onClick={() => goTo('/contrato')}>
              <IconChevron />
              <span className="sd-row-text">Contrato</span>
            </button>
            <button className="sd-row" type="button" onClick={() => goTo('/relatorios')}>
              <IconChevron />
              <span className="sd-row-text">Relatórios</span>
            </button>
          </div>
        </div>

        <div className="sd-section">
          <div className="sd-section-title">Aplicação</div>
          <div className="sd-card" role="group" aria-label="Aplicação">
            <button className="sd-row" type="button" onClick={() => goTo('/tema')}>
              <IconChevron />
              <span className="sd-row-text">Tema</span>
            </button>
            <button className="sd-row" type="button" onClick={() => goTo('/sobre-nos')}>
              <IconChevron />
              <span className="sd-row-text">Sobre Nós</span>
            </button>
          </div>
        </div>

        <div className="sd-section">
          <div className="sd-section-title">Sessão</div>
          <div className="sd-card" role="group" aria-label="Sessão">
            <button className="sd-row" type="button" onClick={() => goTo('/definicoes')}>
              <IconChevron />
              <span className="sd-row-text">Definições</span>
            </button>
            <button className="sd-row" type="button" onClick={logout}>
              <IconChevron />
              <span className="sd-row-text sd-danger">Terminar sessão</span>
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
