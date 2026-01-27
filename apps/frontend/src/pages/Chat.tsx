import React, { useEffect, useMemo, useRef, useState } from 'react';
import logoImg from '../assets/images/logo.png';
import './Dashboard.css';
import './Chat.css';

type ChatRole = 'user' | 'assistant';

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
};

type ChatResponse = {
  reply: string;
  suggestions?: string[];
};

const navItems = [
  { key: 'home', label: 'Home', href: '/dashboard' },
  { key: 'stats', label: 'Estatísticas', href: '/graficos' },
  { key: 'devices', label: 'Dispositivos', href: '/equipamentos' },
  { key: 'security', label: 'Segurança', href: '/seguranca' }
] as const;

function uid() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function Chat() {
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const raw = localStorage.getItem('kynex:chat');
      if (!raw) return [];
      const parsed = JSON.parse(raw) as ChatMessage[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const id = localStorage.getItem('kynex:customerId');
      setCustomerId(id);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('kynex:chat', JSON.stringify(messages.slice(-60)));
    } catch {
      // ignore
    }
  }, [messages]);

  useEffect(() => {
    const apiBases = [
      (import.meta as any).env?.VITE_API_BASE as string | undefined,
      'http://localhost:4100'
    ].filter(Boolean) as string[];

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
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length]);

  const quickPrompts = useMemo(
    () => [
      'Resumo das últimas 24h',
      'O que está a gastar mais?',
      'Tenho standby alto?',
      'Sugestões para poupar este mês',
      'Qual é a minha tarifa e potência contratada?'
    ],
    []
  );

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;

    if (!customerId) {
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: 'assistant', content: 'Preciso do seu perfil primeiro. Complete o Onboarding.', ts: Date.now() }
      ]);
      return;
    }

    if (!apiBase) {
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: 'assistant', content: 'Ainda estou a ligar ao servidor. Tente novamente em instantes.', ts: Date.now() }
      ]);
      return;
    }

    const history = messages
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));

    const userMsg: ChatMessage = { id: uid(), role: 'user', content: message, ts: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setBusy(true);

    try {
      const token = localStorage.getItem('kynex:authToken');
      const res = await fetch(`${apiBase}/customers/${customerId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ message, history })
      });
      if (!res.ok) throw new Error('chat');
      const json = (await res.json()) as ChatResponse;

      const replyText = (json?.reply ?? '').toString().trim() || 'Não consegui responder agora. Tente reformular.';
      setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: replyText, ts: Date.now() }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: 'assistant',
          content: 'Não consegui contactar o backend agora. Verifique se o servidor está online.',
          ts: Date.now()
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void send(input);
  }

  return (
    <div className="app-shell">
      <div className="phone-frame">
        <header className="top-bar">
          <div className="brand">
            <button className="chat-back" type="button" onClick={() => window.location.assign('/dashboard')} aria-label="Voltar">
              ←
            </button>
            <button className="brand-logo" type="button" onClick={() => window.location.assign('/dashboard')} aria-label="Ir para Dashboard">
              <img src={logoImg} alt="Kynex" />
            </button>
            <div className="chat-title">
              <div className="chat-title-small">Assistente</div>
              <div className="chat-title-big">Chat pessoal</div>
            </div>
          </div>
          <div className="top-actions">
            <button className="chat-clear" type="button" onClick={() => setMessages([])} aria-label="Limpar conversa">
              Limpar
            </button>
          </div>
        </header>

        <main className="content chat-content">
          <div className="chat-hint">
            Pergunte sobre consumo, contrato, equipamentos, previsões ou poupança.
          </div>

          <div className="chat-chips" aria-label="Sugestões rápidas">
            {quickPrompts.map((p) => (
              <button key={p} className="chat-chip" type="button" onClick={() => void send(p)}>
                {p}
              </button>
            ))}
          </div>

          <div className="chat-list" ref={listRef} aria-label="Conversa">
            {messages.length === 0 ? (
              <div className="chat-empty">
                <div className="chat-empty-title">Olá! Eu sou o seu assistente.</div>
                <div className="chat-empty-sub">Experimente uma das sugestões acima.</div>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`chat-bubble ${m.role}`}>
                  <div className="chat-bubble-text">{m.content}</div>
                </div>
              ))
            )}
          </div>

          <form className="chat-input" onSubmit={onSubmit}>
            <input
              className="chat-text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={busy ? 'A pensar…' : 'Escreva a sua pergunta…'}
              disabled={busy}
            />
            <button className="chat-send" type="submit" disabled={busy || !input.trim()}>
              Enviar
            </button>
          </form>
        </main>

        <div className="bottom-nav-wrapper">
          <div className="bottom-nav-container">
            <button className="assistant-cta active" aria-label="Assistente IA" type="button">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L15.5 8.5L22 12L15.5 15.5L12 22L8.5 15.5L2 12L8.5 8.5L12 2Z" fill="currentColor" />
              </svg>
            </button>

            <nav className="bottom-nav">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  className="nav-item"
                  onClick={() => window.location.assign(item.href)}
                  type="button"
                >
                  <span className="nav-label">{item.label}</span>
                </button>
              ))}
            </nav>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Chat;
