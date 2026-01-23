
import React, { useState } from 'react';
import Dashboard from './pages/Dashboard';
import Charts from './pages/Charts';
import Onboarding from './pages/Onboarding';
import Equipamentos from './pages/Equipamentos';
import Login from './pages/Login';
import Security from './pages/Security';
import SettingsGeneric from './pages/SettingsGeneric';
import SettingsDrawer from './components/SettingsDrawer';


function getUserInfo() {
  let name = 'Cliente';
  let email = '';
  let photoUrl: string | null = null;
  try {
    const onboardRaw = localStorage.getItem('kynex:onboarding');
    if (onboardRaw) {
      const parsed = JSON.parse(onboardRaw);
      if (parsed?.name) name = parsed.name;
      if (parsed?.email) email = parsed.email;
    }
    const registeredEmail = localStorage.getItem('kynex:registeredEmail');
    if (!email && registeredEmail) email = registeredEmail;
    const photo = localStorage.getItem('kynex:profilePhotoUrl');
    if (photo) photoUrl = photo;
  } catch {}
  return { name, email, photoUrl };
}

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [userInfo, setUserInfo] = useState(getUserInfo());
  const path = window.location.pathname;
  const openSettings = () => setSettingsOpen(true);

  const hasAuth = (() => {
    try {
      return Boolean(localStorage.getItem('kynex:authToken'));
    } catch {
      return false;
    }
  })();

  // Atualiza info do utilizador sempre que o drawer for aberto
  React.useEffect(() => {
    if (!settingsOpen) return;
    setUserInfo(getUserInfo());
  }, [settingsOpen]);

  const drawer = (
    <SettingsDrawer
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      user={userInfo}
      onUserUpdate={(patch) => setUserInfo((u) => ({ ...u, ...patch }))}
    />
  );

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
    return <>
      <Equipamentos onOpenSettings={openSettings} />
      {drawer}
    </>;
  }
  if (path.startsWith('/graficos')) {
    return <>
      <Charts onOpenSettings={openSettings} />
      {drawer}
    </>;
  }
  if (path.startsWith('/seguranca')) {
    return <>
      <Security onOpenSettings={openSettings} />
      {drawer}
    </>;
  }

  // Páginas simples para navegação do menu lateral de Configurações
  if (
    path.startsWith('/perfil') ||
    path.startsWith('/loja') ||
    path.startsWith('/plano') ||
    path.startsWith('/faturas') ||
    path.startsWith('/contrato') ||
    path.startsWith('/relatorios') ||
    path.startsWith('/tema') ||
    path.startsWith('/sobre-nos') ||
    path.startsWith('/definicoes')
  ) {
    return <SettingsGeneric />;
  }

  // Suporta links diretos como /dashboard (Netlify/SPA)
  if (path.startsWith('/dashboard')) {
    return <>
      <Dashboard onOpenSettings={openSettings} />
      {drawer}
    </>;
  }

  return <>
    <Dashboard onOpenSettings={openSettings} />
    {drawer}
  </>;
}

export default App;