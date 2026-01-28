import React from 'react';
import Dashboard from './pages/Dashboard';
import Charts from './pages/Charts';
import Onboarding from './pages/Onboarding';
import Equipamentos from './pages/Equipamentos';
import Login from './pages/Login';
import Security from './pages/Security';
import SettingsGeneric from './pages/SettingsGeneric';
import Contrato from './pages/Contrato';
import SobreNos from './pages/SobreNos';
import Faturas from './pages/Faturas';
import Definicoes from './pages/Definicoes';
import Notifications from './pages/Notifications';

function App() {
  const path = window.location.pathname;

  const hasAuth = (() => {
    try {
      return Boolean(localStorage.getItem('kynex:authToken'));
    } catch {
      return false;
    }
  })();

  // Sem sessão: permite Login/Onboarding, caso contrário força Login.
  if (!hasAuth) {
    if (path.startsWith('/onboarding')) return <Onboarding />;
    if (path.startsWith('/login')) return <Login />;
    return <Login />;
  }

  // Com sessão: oculta Login/Onboarding (mantém páginas no código, mas não no fluxo normal)
  if (path.startsWith('/onboarding') || path.startsWith('/login')) {
    try {
      window.history.replaceState(null, '', '/dashboard');
    } catch {
      // ignore
    }
    return <Dashboard />;
  }

  // Com sessão: ao entrar na raiz, força sempre Dashboard
  if (path === '/' || path === '') {
    try {
      window.history.replaceState(null, '', '/dashboard');
    } catch {
      // ignore
    }
    return <Dashboard />;
  }
  if (path.startsWith('/equipamentos')) {
    return <Equipamentos />;
  }
  if (path.startsWith('/graficos')) {
    return <Charts />;
  }
  if (path.startsWith('/seguranca')) {
    return <Security />;
  }

  if (path.startsWith('/notificacoes')) {
    return <Notifications />;
  }

  // Página de Contrato
  if (path.startsWith('/contrato')) {
    return <Contrato />;
  }

  // Página Sobre Nós
  if (path.startsWith('/sobre-nos')) {
    return <SobreNos />;
  }

  // Página Faturas
  if (path.startsWith('/faturas')) {
    return <Faturas />;
  }

  // Página Definições
  if (path.startsWith('/definicoes')) {
    return <Definicoes />;
  }

  // Páginas simples para navegação do menu lateral de Configurações
  if (
    path.startsWith('/perfil') ||
    path.startsWith('/loja') ||
    path.startsWith('/plano') ||
    path.startsWith('/relatorios') ||
    path.startsWith('/tema')
  ) {
    return <SettingsGeneric />;
  }

  // Suporta links diretos como /dashboard (Netlify/SPA)
  if (path.startsWith('/dashboard')) {
    return <Dashboard />;
  }

  return <Dashboard />;
}

export default App;