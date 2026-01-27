import React, { useMemo, useState } from 'react';
import './Onboarding.css';
import logoImg from '../assets/images/logo.png';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function safeDel(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function Login() {
  const [email, setEmail] = useState(() => safeGet('kynex:registeredEmail') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const infoMessage = useMemo(() => {
    const okAt = safeGet('kynex:registerOk');
    if (!okAt) return null;
    return 'Conta criada com sucesso. Faça login para continuar.';
  }, []);

  const isAuthed = Boolean(safeGet('kynex:authToken'));
  if (isAuthed && window.location.pathname.startsWith('/login')) {
    window.setTimeout(() => window.location.assign('/dashboard'), 0);
  }

  const apiBases = useMemo(() => {
    return [
      (import.meta as any).env?.VITE_API_BASE as string | undefined,
      'http://localhost:4100'
    ].filter(Boolean) as string[];
  }, []);

  async function doLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Preencha email e password.');
      return;
    }

    setIsSubmitting(true);
    try {
      for (const base of apiBases) {
        try {
          const res = await fetch(`${base}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: trimmedEmail, password })
          });
          if (!res.ok) {
            if (res.status === 401) {
              setError('Credenciais inválidas.');
              return;
            }
            continue;
          }
          const json = (await res.json()) as { token?: string; customerId?: string };
          if (!json?.token || !json?.customerId) {
            setError('Resposta inválida do servidor.');
            return;
          }

          safeSet('kynex:authToken', json.token);
          safeSet('kynex:customerId', json.customerId);
          safeDel('kynex:registerOk');

          window.location.assign('/dashboard');
          return;
        } catch {
          // tenta próxima base
        }
      }

      setError('Não foi possível ligar ao servidor.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function goRegister() {
    window.location.assign('/onboarding');
  }

  return (
    <div className="onb-shell">
      <div className="onb-frame">
        <div className="onb-header">
          <div className="onb-brand">
            <div className="onb-brand-mark"><img src={logoImg} alt="Kynex" /></div>
          </div>
        </div>

        <div className="onb-hero">
          <div className="onb-hero-title">Bem-vindo(a) de volta</div>
          <div className="onb-hero-subtitle">Faça login para aceder ao seu painel.</div>
        </div>

        <div className="onb-card">
          <div className="onb-card-top">
            <div className="onb-chip">Login</div>
            <p className="onb-label">Email</p>
          </div>

          <div className="onb-card-body">
            <input
              className="onb-input"
              type="email"
              placeholder="Ex.: ana@email.com"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              autoComplete="email"
            />

            <p className="onb-label" style={{ marginTop: 14 }}>Password</p>
            <input
              className="onb-input"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              autoComplete="current-password"
            />

            {infoMessage && (
              <div className="onb-helper" style={{ marginTop: 10 }}>
                {infoMessage}
              </div>
            )}

            {error && (
              <div className="onb-helper" style={{ marginTop: 10, color: '#b42318' }}>
                {error}
              </div>
            )}
          </div>

          <div className="onb-actions">
            <button className="onb-btn ghost" onClick={goRegister} type="button" disabled={isSubmitting}>
              Registar
            </button>
            <button className="onb-btn" onClick={doLogin} type="button" disabled={isSubmitting}>
              {isSubmitting ? 'A entrar…' : 'Entrar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;
