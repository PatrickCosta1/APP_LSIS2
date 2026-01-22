import React from 'react';
import Dashboard from './pages/Dashboard';
import Charts from './pages/Charts';
import Onboarding from './pages/Onboarding';
import Equipamentos from './pages/Equipamentos';
import Login from './pages/Login';
import Security from './pages/Security';

function App() {
  const path = window.location.pathname;

  const hasAuth = (() => {
    try {
      return Boolean(localStorage.getItem('kynex:authToken'));
    } catch {
      return false;
    }
  })();

  if (path.startsWith('/onboarding')) {
    return <Onboarding />;
  }
  if (path.startsWith('/login')) {
    return <Login />;
  }

  // Primeira execução: força login como página inicial
  if (!hasAuth) {
    return <Login />;
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

  // Suporta links diretos como /dashboard (Netlify/SPA)
  if (path.startsWith('/dashboard')) {
    return <Dashboard />;
  }

  return <Dashboard />;
}

export default App;