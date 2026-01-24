import React, { useEffect, useState } from 'react';
import logoImg from '../assets/images/logo2.png';
import linkedLogo from '../assets/images/linkedIn.png';
import SettingsDrawer from '../components/SettingsDrawer';
import './SobreNos.css';

function IconBack() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function SobreNos() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customerName, setCustomerName] = useState<string>('Cliente');
  const [userEmail, setUserEmail] = useState<string>('');
  const [userPhotoUrl, setUserPhotoUrl] = useState<string | null>(null);

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

  return (
    <div className="app-shell sobre-nos-shell">
      <div className="phone-frame sobre-nos-frame">
        <header className="top-bar sobre-nos-header">
          <div className="brand">
            <div className="brand-logo">
              <img src={logoImg} alt="Kynex" />
            </div>
          </div>
          <div className="sobre-nos-actions">
            <button
              className="sobre-nos-back"
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

        {/* 1. Cabeçalho (Logo + Slogan) */}
        <div className="sobre-nos-hero">
          <div className="sobre-nos-hero-logo">
            <img src={logoImg} alt="Kynex Pulse" />
          </div>
          <h1 className="sobre-nos-slogan">Systems Moving Forward</h1>
        </div>

        <main className="sobre-nos-content">
          {/* 2. O Manifesto (A Missão) */}
          <section className="sobre-nos-manifesto">
            <h2 className="sobre-nos-manifesto-title">
              Acreditamos que a energia não deve ser um custo invisível.
            </h2>
            <p className="sobre-nos-manifesto-text">
              A Kynex nasceu com um propósito claro: aumentar a <span className="highlight">literacia energética</span> das 
              famílias portuguesas. Utilizamos <span className="highlight">Inteligência Artificial</span> para traduzir dados 
              complexos em poupança real, transformando a forma como interage com a sua casa.
            </p>
            <p className="sobre-nos-manifesto-text">
              Não queremos apenas que pague menos; <strong>queremos que entenda melhor</strong>.
            </p>
          </section>

          {/* 3. A Origem (Credibilidade Académica) */}
          <section className="sobre-nos-origem">
            <h2 className="sobre-nos-origem-title">A Origem</h2>
            <p className="sobre-nos-origem-text">
              Este projeto foi desenvolvido no âmbito da Licenciatura em Engenharia de Sistemas do{' '}
              <span className="highlight">ISEP</span> (Instituto Superior de Engenharia do Porto). 
              O que começou como um desafio curricular, evoluiu para uma missão de sustentabilidade 
              e inovação tecnológica.
            </p>
          </section>

          {/* 4. Conecte-se connosco (Botões/Links) */}
          <section className="sobre-nos-links">
            <h2 className="sobre-nos-links-title">Conecte-se connosco</h2>
            <div className="sobre-nos-buttons">
              <a 
                href="https://kynex-pt.netlify.app/home" 
                target="_blank" 
                rel="noopener noreferrer"
                className="sobre-nos-button"
              >
                <div className="sobre-nos-button-icon">
                  <img src={logoImg} alt="Kynex" className="sobre-nos-button-img" />
                </div>
                <span className="sobre-nos-button-text">Visite o nosso Site</span>
              </a>

              <a 
                href="https://www.linkedin.com/company/kynexpt/?viewAsMember=true" 
                target="_blank" 
                rel="noopener noreferrer"
                className="sobre-nos-button"
              >
                <div className="sobre-nos-button-icon">
                  <img src={linkedLogo} alt="LinkedIn" className="sobre-nos-button-img" />
                </div>
                <span className="sobre-nos-button-text">Siga-nos no LinkedIn</span>
              </a>

              
            </div>
          </section>

          {/* 5. Rodapé (Versão e Legal) */}
          <footer className="sobre-nos-footer">
            <p className="sobre-nos-footer-legal">
              © 2026 Kynex
            </p>
          </footer>
        </main>
      </div>
    </div>
  );
}
