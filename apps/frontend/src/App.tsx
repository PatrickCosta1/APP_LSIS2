import React from 'react';
import Dashboard from './pages/Dashboard';
import Charts from './pages/Charts';
import Onboarding from './pages/Onboarding';
import Equipamentos from './pages/Equipamentos';

function App() {
  const path = window.location.pathname;

  const hasCustomer = (() => {
    try {
      return Boolean(localStorage.getItem('kynex:customerId'));
    } catch {
      return false;
    }
  })();

  // Primeira execução: força onboarding como página inicial
  if (!hasCustomer && !path.startsWith('/onboarding')) {
    return <Onboarding />;
  }

  if (path.startsWith('/onboarding')) {
    return <Onboarding />;
  }
  if (path.startsWith('/equipamentos')) {
    return <Equipamentos />;
  }
  if (path.startsWith('/graficos')) {
    return <Charts />;
  }

  // Suporta links diretos como /dashboard (Netlify/SPA)
  if (path.startsWith('/dashboard')) {
    return <Dashboard />;
  }

  return <Dashboard />;
}

export default App;