import React, { useEffect, useMemo, useRef, useState } from 'react';
import './AssistantChatModal.css';

type ChatHistoryResponse = {
  conversationId: string | null;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; createdAt: string }>;
};

type ChatReplyResponse = {
  conversationId: string;
  reply: string;
  cards?: ChatCard[];
  actions?: ChatAction[];
};

type ChatCard =
  | { kind: 'metric'; title: string; value: string; subtitle?: string }
  | { kind: 'tip'; title: string; detail: string }
  | { kind: 'list'; title: string; items: string[]; subtitle?: string };

type ChatAction =
  | { kind: 'button'; id: string; label: string; message: string }
  | {
      kind: 'plan';
      id: string;
      title: string;
      items: Array<{ id: string; label: string; detail?: string }>;
    };

type Props = {
  open: boolean;
  onClose: () => void;
  apiBase?: string | null;
  customerId?: string | null;
};

function safeGetLocalStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export default function AssistantChatModal({ open, onClose, apiBase: apiBaseProp, customerId: customerIdProp }: Props) {
  const [apiBase, setApiBase] = useState<string | null>(apiBaseProp ?? null);
  const [customerId, setCustomerId] = useState<string | null>(customerIdProp ?? null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string; cards?: ChatCard[]; actions?: ChatAction[] }>>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [planProgress, setPlanProgress] = useState<Record<string, Record<string, boolean>>>({});

  const listRef = useRef<HTMLDivElement | null>(null);

  const convStorageKey = useMemo(() => {
    if (!customerId) return null;
    return `kynex:chatConversationId:${customerId}`;
  }, [customerId]);

  useEffect(() => {
    setApiBase(apiBaseProp ?? null);
  }, [apiBaseProp]);

  useEffect(() => {
    setCustomerId(customerIdProp ?? null);
  }, [customerIdProp]);

  useEffect(() => {
    if (customerIdProp) return;
    const id = safeGetLocalStorage('kynex:customerId');
    if (id) setCustomerId(id);
  }, [customerIdProp]);

  useEffect(() => {
    if (apiBaseProp) return;

    const apiBases = [
      (import.meta as any).env?.VITE_API_BASE as string | undefined,
      'http://localhost:4000',
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
          // tenta próxima
        }
      }
    }

    resolveBase();
    return () => {
      cancelled = true;
    };
  }, [apiBaseProp]);

  useEffect(() => {
    if (!open) return;
    setError(null);

    if (!apiBase || !customerId) {
      setMessages([
        {
          role: 'assistant',
          content: 'Não consegui abrir o assistente: falta customerId ou ligação ao backend. Faça o onboarding e confirme que o backend está a correr.'
        }
      ]);
      return;
    }

    let cancelled = false;

    async function loadHistory() {
      setLoading(true);
      try {
        const existingConv = convStorageKey ? safeGetLocalStorage(convStorageKey) : null;
        const qs = new URLSearchParams();
        if (existingConv) qs.set('conversationId', existingConv);
        qs.set('limit', '50');

        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(`${apiBase}/customers/${customerId}/chat?${qs.toString()}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('history');
        const json = (await res.json()) as ChatHistoryResponse;

        if (cancelled) return;

        if (json.conversationId) {
          setConversationId(json.conversationId);
          if (convStorageKey) safeSetLocalStorage(convStorageKey, json.conversationId);
        }

        const mapped = (json.messages ?? [])
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content ?? '') }));

        if (mapped.length) setMessages(mapped);
        else
          setMessages([
            {
              role: 'assistant',
              content: 'Olá! Sou o teu assistente Kynex. Diz-me o que queres analisar: consumo, equipamentos, poupança ou potência contratada.'
            }
          ]);

      } catch {
        if (!cancelled) {
          setError('Não foi possível carregar o histórico.');
          setMessages([
            {
              role: 'assistant',
              content: 'Olá! Posso ajudar mesmo sem histórico. Faz uma pergunta como: “Quanto gastei nas últimas 24h?”'
            }
          ]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [open, apiBase, customerId, convStorageKey]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [open, messages, loading]);

  useEffect(() => {
    if (!customerId || !conversationId) return;
    const needed: Array<{ storageKey: string; planId: string }> = [];

    for (const msg of messages) {
      for (const act of msg.actions ?? []) {
        if (act.kind !== 'plan') continue;
        const storageKey = `kynex:chatPlan:${customerId}:${conversationId}:${act.id}`;
        if (!planProgress[storageKey]) needed.push({ storageKey, planId: act.id });
      }
    }

    if (!needed.length) return;
    setPlanProgress((prev) => {
      const next = { ...prev };
      for (const { storageKey } of needed) {
        const raw = safeGetLocalStorage(storageKey);
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Record<string, boolean>;
            next[storageKey] = parsed && typeof parsed === 'object' ? parsed : {};
          } catch {
            next[storageKey] = {};
          }
        } else {
          next[storageKey] = {};
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, customerId, conversationId]);

  function renderCards(cards?: ChatCard[]) {
    if (!cards?.length) return null;
    return (
      <div className="assistant-cards">
        {cards.map((card, idx) => {
          if (card.kind === 'metric') {
            return (
              <div key={idx} className="assistant-card assistant-card-metric">
                <div className="assistant-card-title">{card.title}</div>
                <div className="assistant-card-value">{card.value}</div>
                {card.subtitle ? <div className="assistant-card-subtitle">{card.subtitle}</div> : null}
              </div>
            );
          }

          if (card.kind === 'tip') {
            return (
              <div key={idx} className="assistant-card assistant-card-tip">
                <div className="assistant-card-title">{card.title}</div>
                <div className="assistant-card-detail">{card.detail}</div>
              </div>
            );
          }

          if (card.kind === 'list') {
            return (
              <div key={idx} className="assistant-card assistant-card-list">
                <div className="assistant-card-title">{card.title}</div>
                {card.subtitle ? <div className="assistant-card-subtitle">{card.subtitle}</div> : null}
                <ul className="assistant-card-list-items">
                  {card.items.map((it, i) => (
                    <li key={i}>{it}</li>
                  ))}
                </ul>
              </div>
            );
          }

          return null;
        })}
      </div>
    );
  }

  function renderActions(actions?: ChatAction[]) {
    if (!actions?.length) return null;

    return (
      <div className="assistant-actions">
        {actions.map((a) => {
          if (a.kind === 'button') {
            return (
              <button
                key={a.id}
                type="button"
                className="assistant-action-btn"
                disabled={loading}
                onClick={() => void send(a.message, a.label)}
              >
                {a.label}
              </button>
            );
          }

          if (a.kind === 'plan') {
            if (!customerId || !conversationId) return null;
            const storageKey = `kynex:chatPlan:${customerId}:${conversationId}:${a.id}`;
            const prog = planProgress[storageKey] ?? {};
            const doneCount = a.items.reduce((acc, it) => acc + (prog[it.id] ? 1 : 0), 0);
            const total = a.items.length;

            return (
              <div key={a.id} className="assistant-plan">
                <div className="assistant-plan-title">
                  {a.title}
                  <span className="assistant-plan-progress">
                    {doneCount}/{total}
                  </span>
                </div>
                <div className="assistant-plan-items">
                  {a.items.map((it) => (
                    <label key={it.id} className="assistant-plan-item">
                      <input
                        type="checkbox"
                        checked={Boolean(prog[it.id])}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setPlanProgress((prev) => {
                            const next = { ...prev };
                            const plan = { ...(next[storageKey] ?? {}) };
                            plan[it.id] = checked;
                            next[storageKey] = plan;
                            safeSetLocalStorage(storageKey, JSON.stringify(plan));
                            return next;
                          });
                        }}
                      />
                      <span>
                        <span className="assistant-plan-item-label">{it.label}</span>
                        {it.detail ? <span className="assistant-plan-item-detail">{it.detail}</span> : null}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          }

          return null;
        })}
      </div>
    );
  }

  async function send(message: string, displayText?: string) {
    if (!apiBase || !customerId) return;
    const trimmed = message.trim();
    if (!trimmed) return;

    const display = (displayText ?? trimmed).trim();
    if (!display) return;

    setError(null);
    setLoading(true);

    setMessages((prev) => [...prev, { role: 'user', content: display }]);
    setDraft('');

    try {
      const token = localStorage.getItem('kynex:authToken');
      const res = await fetch(`${apiBase}/customers/${customerId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ message: trimmed, conversationId: conversationId ?? undefined })
      });

      if (!res.ok) throw new Error('chat');
      const json = (await res.json()) as ChatReplyResponse;

      setConversationId(json.conversationId);
      if (convStorageKey) safeSetLocalStorage(convStorageKey, json.conversationId);

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: String(json.reply ?? ''),
          cards: Array.isArray(json.cards) ? (json.cards as ChatCard[]) : undefined,
          actions: Array.isArray(json.actions) ? (json.actions as ChatAction[]) : undefined
        }
      ]);
    } catch {
      setError('Falha ao enviar mensagem.');
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Tive um problema a responder. Tenta novamente.' }]);
    } finally {
      setLoading(false);
    }
  }

  function onOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  if (!open) return null;

  return (
    <div className="assistant-modal-overlay" onMouseDown={onOverlayClick} role="dialog" aria-modal="true" aria-label="Assistente">
      <div className="assistant-modal">
        <div className="assistant-header">
          <div className="assistant-title">
            Assistente
            <div className="assistant-subtitle">Consumos, equipamentos e poupança</div>
          </div>
          <button className="assistant-close" type="button" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </div>

        <div className="assistant-body" ref={listRef}>
          {messages.map((m, idx) => (
            <div key={idx} className={`assistant-msg ${m.role}`}> 
              <div className="assistant-bubble">
                {m.content}
                {m.role === 'assistant' ? renderCards(m.cards) : null}
                {m.role === 'assistant' ? renderActions(m.actions) : null}
              </div>
            </div>
          ))}

          {loading ? (
            <div className="assistant-msg assistant">
              <div className="assistant-bubble assistant-typing">A pensar…</div>
            </div>
          ) : null}
        </div>

        <div className="assistant-quick">
          <button type="button" className="assistant-quick-btn" onClick={() => send('Quanto gastei nas últimas 24h?')}>
            24h
          </button>
          <button type="button" className="assistant-quick-btn" onClick={() => send('Qual o equipamento que mais consome?')}>
            Top equipamento
          </button>
          <button type="button" className="assistant-quick-btn" onClick={() => send('Dá-me 3 dicas para poupar esta semana.')}
          >
            3 dicas
          </button>
          <button type="button" className="assistant-quick-btn" onClick={() => send('__ACTION:PLAN_7D__', 'Plano 7 dias')}>
            Plano 7 dias
          </button>
        </div>

        <form
          className="assistant-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <input
            className="assistant-text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Escreve aqui…"
            disabled={loading}
            aria-label="Mensagem"
          />
          <button className="assistant-send" type="submit" disabled={loading || !draft.trim()}>
            Enviar
          </button>
        </form>

        {error ? <div className="assistant-error">{error}</div> : null}
      </div>
    </div>
  );
}
