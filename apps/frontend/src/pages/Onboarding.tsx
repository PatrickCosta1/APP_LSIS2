import React, { useMemo, useState } from 'react';
import './Onboarding.css';
import logoImg from '../assets/images/logo.png';

type Step =
  | {
      id: string;
      type: 'text';
      label: string;
      placeholder: string;
      helper?: string;
      inputType?: 'text' | 'email' | 'password' | 'number';
      min?: number;
      max?: number;
      step?: number;
    }
  | {
      id: string;
      type: 'single';
      label: string;
      helper?: string;
      options: string[];
    }
  | {
      id: string;
      type: 'multi';
      label: string;
      helper?: string;
      options: string[];
    };

const steps: Step[] = [
  { id: 'nome', type: 'text', label: 'Como se chama?', placeholder: 'Ex.: Ana Silva', inputType: 'text' },
  { id: 'email', type: 'text', label: 'Qual o seu email?', placeholder: 'Ex.: ana@email.com', inputType: 'email' },
  {
    id: 'password',
    type: 'text',
    label: 'Crie uma password',
    placeholder: '••••••••',
    inputType: 'password',
    helper: 'Mín. 8 caracteres, com maiúscula, minúscula, número e símbolo (sem espaços).'
  },
  { id: 'password_confirm', type: 'text', label: 'Confirme a password', placeholder: '••••••••', inputType: 'password' },
  {
    id: 'tamanho',
    type: 'single',
    label: 'Tamanho da casa (m²)',
    options: ['< 60 m²', '60-90 m²', '90-120 m²', '120-180 m²', '> 180 m²'],
  },
  {
    id: 'pessoas',
    type: 'single',
    label: 'Quantas pessoas vivem na casa?',
    options: ['1', '2', '3', '4', '5+',],
  },
  {
    id: 'distrito',
    type: 'single',
    label: 'Distrito',
    options: ['Aveiro', 'Braga', 'Coimbra', 'Faro', 'Lisboa', 'Porto', 'Setúbal', 'Outro'],
  },
  {
    id: 'localidade',
    type: 'single',
    label: 'Tipo de localidade',
    options: ['Urbana', 'Suburbana', 'Rural'],
  },
  {
    id: 'ano',
    type: 'single',
    label: 'Ano de construção / renovação',
    options: ['Antes de 1980', '1980-1999', '2000-2014', '2015-2020', '2021 ou mais recente'],
  },
  {
    id: 'tipo',
    type: 'single',
    label: 'Tipo de habitação',
    options: ['Apartamento', 'Moradia isolada', 'Moradia geminada', 'Duplex / Loft'],
  },
  {
    id: 'aquecimento',
    type: 'multi',
    label: 'Fontes de aquecimento',
    helper: 'Pode escolher várias',
    options: ['Elétrico', 'Gás', 'Bomba de calor', 'Lenha / Pellets', 'Outro'],
  },
  {
    id: 'painel',
    type: 'single',
    label: 'Tem painéis solares?',
    options: ['Sim', 'Não'],
  },
  {
    id: 'veiculos',
    type: 'single',
    label: 'Veículos elétricos (0 a 5)',
    helper: 'Quantos veículos elétricos existem no agregado?',
    options: ['0', '1', '2', '3', '4', '5'],
  },
  {
    id: 'fornecedor',
    type: 'single',
    label: 'Fornecedor / Comercializador',
    options: ['EDP', 'Endesa', 'Iberdrola', 'Outro', 'Não sei'],
  },
  {
    id: 'tarifa_tipo',
    type: 'single',
    label: 'Tipo de tarifa',
    options: ['Simples', 'Bi-horário', 'Tri-horário', 'Não sei'],
  },
  {
    id: 'potencia_contratada',
    type: 'single',
    label: 'Potência contratada (kVA)',
    helper: 'Escolha a potência indicada na fatura/contrato.',
    options: ['1,15 kVA', '2,3 kVA', '3,45 kVA', '4,6 kVA', '5,75 kVA', '6,9 kVA', '10,35 kVA', '13,8 kVA', '17,25 kVA', '20,7 kVA', '27,6 kVA', '34,5 kVA', '41,4 kVA'],
  },
  {
    id: 'preco_kwh',
    type: 'text',
    label: 'Preço médio da energia (€/kWh)',
    helper: 'Opcional. Ex.: 0.18',
    placeholder: '0.18',
    inputType: 'number',
    min: 0,
    max: 2,
    step: 0.001,
  },
  {
    id: 'taxa_fixa_dia',
    type: 'text',
    label: 'Taxa fixa / termo de potência (€/dia)',
    helper: 'Opcional. Ex.: 0.22',
    placeholder: '0.22',
    inputType: 'number',
    min: 0,
    max: 5,
    step: 0.01,
  },
  {
    id: 'contador_inteligente',
    type: 'single',
    label: 'Tem contador inteligente?',
    options: ['Sim', 'Não', 'Não sei'],
  },
  {
    id: 'equipamentos',
    type: 'multi',
    label: 'Equipamentos principais',
    helper: 'Pode escolher várias',
    options: [
      'Frigorífico/Arca',
      'Máquina de lavar roupa',
      'Máquina de lavar loiça',
      'Forno',
      'Placa/Indução',
      'Micro-ondas',
      'Secador de roupa',
      'Ar condicionado',
      'Termoacumulador',
      'Bomba de calor',
      'Desumidificador',
      'Aquecedor portátil',
      'Bomba de água',
      'Piscina',
      'Carregador EV'
    ],
  },
  {
    id: 'alertas',
    type: 'single',
    label: 'Sensibilidade a alertas',
    options: ['Baixa', 'Média', 'Alta'],
  },
];

function Onboarding() {
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const step = steps[stepIndex];
  const total = steps.length;
  const progress = Math.round(((stepIndex + 1) / total) * 100);

  function setAnswer(value: string | string[]) {
    setAnswers((prev) => ({ ...prev, [step.id]: value }));
  }

  function toggleMulti(option: string) {
    const current = (answers[step.id] as string[] | undefined) ?? [];
    const exists = current.includes(option);
    const next = exists ? current.filter((o) => o !== option) : [...current, option];
    setAnswer(next);
  }

  function nextStep() {
    if (stepIndex < total - 1) setStepIndex((i) => i + 1);
  }

  function prevStep() {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  }

  function openReview() {
    setIsReviewOpen(true);
    setIsConfirmed(false);
    setSubmitError(null);
  }

  function closeReview() {
    setIsReviewOpen(false);
    setIsConfirmed(false);
    setSubmitError(null);
  }

  function confirmAndContinue() {
    setSubmitError(null);

    const pwd = typeof answers.password === 'string' ? answers.password : '';
    const pwd2 = typeof answers.password_confirm === 'string' ? answers.password_confirm : '';
    if (!pwd || !pwd2) {
      setSubmitError('Preencha a password e a confirmação.');
      return;
    }
    if (pwd !== pwd2) {
      setSubmitError('A confirmação de password não coincide.');
      return;
    }

    setIsConfirmed(true);
    setIsSubmitting(true);

    const apiBases = [
      (import.meta as any).env?.VITE_API_BASE as string | undefined,
      'http://localhost:4100'
    ].filter(Boolean) as string[];

    const parsePowerKva = (v: unknown): number | null => {
      if (typeof v !== 'string') return null;
      const norm = v.replace(',', '.');
      const m = norm.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (!m) return null;
      const n = Number(m[1]);
      if (!Number.isFinite(n)) return null;
      if (n < 1 || n > 45) return null;
      return n;
    };

    const approxAreaM2 = (band: unknown): number => {
      switch (band) {
        case '< 60 m²':
          return 50;
        case '60-90 m²':
          return 75;
        case '90-120 m²':
          return 105;
        case '120-180 m²':
          return 150;
        case '> 180 m²':
          return 210;
        default:
          return 80;
      }
    };

    const parseHousehold = (v: unknown): number => {
      if (typeof v !== 'string') return 2;
      if (v === '5+') return 5;
      const n = Number(v);
      return Number.isFinite(n) ? n : 2;
    };

    const parseEvCount = (v: unknown): number => {
      if (typeof v !== 'string') return 0;
      const n = Number(v);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(5, Math.round(n)));
    };

    const toBool = (v: unknown): boolean | null => {
      if (v === 'Sim') return true;
      if (v === 'Não') return false;
      return null;
    };

    const payload = {
      email: typeof answers.email === 'string' ? answers.email : '',
      password: pwd,
      name: typeof answers.nome === 'string' ? answers.nome : 'Cliente',
      segment: 'residential',
      city: typeof answers.distrito === 'string' ? answers.distrito : 'Porto',
      contracted_power_kva: parsePowerKva(answers.potencia_contratada) ?? 6.9,
      tariff: typeof answers.tarifa_tipo === 'string' ? answers.tarifa_tipo : 'Simples',
      utility: typeof answers.fornecedor === 'string' ? answers.fornecedor : 'EDP',
      price_eur_per_kwh:
        typeof answers.preco_kwh === 'string' && answers.preco_kwh.trim() ? Number(answers.preco_kwh) : undefined,
      fixed_daily_fee_eur:
        typeof answers.taxa_fixa_dia === 'string' && answers.taxa_fixa_dia.trim() ? Number(answers.taxa_fixa_dia) : undefined,
      has_smart_meter: toBool(answers.contador_inteligente) ?? true,

      home_area_m2: approxAreaM2(answers.tamanho),
      household_size: parseHousehold(answers.pessoas),
      locality_type: typeof answers.localidade === 'string' ? answers.localidade : 'Urbana',
      dwelling_type: typeof answers.tipo === 'string' ? answers.tipo : 'Apartamento',
      build_year_band: typeof answers.ano === 'string' ? answers.ano : '2000-2014',
      heating_sources: Array.isArray(answers.aquecimento) ? answers.aquecimento : [],
      has_solar: toBool(answers.painel) ?? false,
      ev_count: parseEvCount(answers.veiculos),
      alert_sensitivity: typeof answers.alertas === 'string' ? answers.alertas : 'Média',
      main_appliances: Array.isArray(answers.equipamentos) ? answers.equipamentos : []
    };

    try {
      const safePayload = { ...payload } as any;
      delete safePayload.password;
      localStorage.setItem('kynex:onboarding', JSON.stringify(safePayload));
    } catch {
      // ignore
    }

    (async () => {
      try {
        for (const base of apiBases) {
          try {
            const res = await fetch(`${base}/auth/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            if (!res.ok) {
              if (res.status === 409) {
                setSubmitError('Este email já está registado.');
                setIsConfirmed(false);
                return;
              }
              if (res.status === 400) {
                const j = (await res.json().catch(() => null)) as any;
                const msg = typeof j?.message === 'string' ? j.message : 'Dados inválidos.';
                const errs = Array.isArray(j?.errors) ? j.errors.join(' ') : '';
                setSubmitError(`${msg}${errs ? ` ${errs}` : ''}`);
                setIsConfirmed(false);
                return;
              }
              continue;
            }

            try {
              localStorage.setItem('kynex:registerOk', new Date().toISOString());
              if (typeof answers.email === 'string') localStorage.setItem('kynex:registeredEmail', answers.email);
            } catch {
              // ignore
            }

            window.setTimeout(() => window.location.assign('/login'), 900);
            return;
          } catch {
            // tenta próxima base
          }
        }

        setSubmitError('Não foi possível ligar ao servidor.');
        setIsConfirmed(false);
      } finally {
        setIsSubmitting(false);
      }
    })();
  }

  const summary = useMemo(() => {
    const labelById = new Map(steps.map((s) => [s.id, s.label] as const));
    const order = steps.map((s) => s.id);

    return order
      .filter((id) => id !== 'password' && id !== 'password_confirm')
      .map((id) => {
        const v = answers[id];
        const label = labelById.get(id) ?? id;
        const valueText = Array.isArray(v) ? v.join(', ') : (v ?? '').toString();
        return { id, label, valueText: valueText || '—' };
      });
  }, [answers]);

  const value = answers[step.id];

  const isNextDisabled = useMemo(() => {
    const optionalTextIds = new Set(['preco_kwh', 'taxa_fixa_dia']);
    if (step.type === 'multi') return false; // permite avançar mesmo sem selecionar
    if (step.type === 'single') return !value;
    if (step.type === 'text') {
      if (optionalTextIds.has(step.id)) return false;
      const txt = (value as string) ?? '';
      if (!txt.trim()) return true;
      return false;
    }
    return false;
  }, [step, value]);

  return (
    <div className="onb-shell">
      <div className="onb-frame">
        <div className="onb-header">
          <div className="onb-brand">
            <div className="onb-brand-mark"><img src={logoImg} alt="Kynex" /></div>
          </div>

          <div className="onb-header-right">
            <div className="onb-step">{stepIndex + 1}/{total}</div>
            <div className="onb-progress" aria-label="Progresso">
              <div className="onb-progress-bar" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>

        <div className="onb-hero">
          <div className="onb-hero-title">Vamos personalizar a sua experiência</div>
          <div className="onb-hero-subtitle">Responda em 1 minuto — melhora as previsões e sugestões.</div>
        </div>

        <div className="onb-card">
          <div className="onb-card-top">
            <div className="onb-chip">Passo {stepIndex + 1}</div>
            <p className="onb-label">{step.label}</p>
            {step.helper && <p className="onb-helper">{step.helper}</p>}
          </div>

          <div className="onb-card-body">
            {step.type === 'text' && (
              <input
                className="onb-input"
                type={step.inputType ?? 'text'}
                placeholder={step.placeholder}
                value={(value as string) ?? ''}
                onChange={(e) => setAnswer(e.target.value)}
                min={step.inputType === 'number' ? step.min : undefined}
                max={step.inputType === 'number' ? step.max : undefined}
                step={step.inputType === 'number' ? step.step : undefined}
                autoFocus
              />
            )}

            {step.type === 'single' && (
              <div className="onb-options grid">
                {step.options.map((opt) => {
                  const active = value === opt;
                  return (
                    <button
                      key={opt}
                      className={`onb-opt ${active ? 'active' : ''}`}
                      onClick={() => setAnswer(opt)}
                      type="button"
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            )}

            {step.type === 'multi' && (
              <div className="onb-options grid">
                {step.options.map((opt) => {
                  const selected = Array.isArray(value) && value.includes(opt);
                  return (
                    <button
                      key={opt}
                      className={`onb-opt ${selected ? 'active' : ''}`}
                      onClick={() => toggleMulti(opt)}
                      type="button"
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="onb-actions">
            <button className="onb-btn ghost" onClick={prevStep} disabled={stepIndex === 0} type="button">
              Anterior
            </button>
            {stepIndex < total - 1 ? (
              <button className="onb-btn" onClick={nextStep} disabled={isNextDisabled} type="button">
                Seguinte
              </button>
            ) : (
              <button className="onb-btn" onClick={openReview} type="button">
                Concluir
              </button>
            )}
          </div>
        </div>

        {isReviewOpen && (
          <div className="onb-modal-overlay" role="dialog" aria-modal="true" aria-label="Confirmar informações">
            <div className="onb-modal">
              {!isConfirmed ? (
                <>
                  <div className="onb-modal-header">
                    <div className="onb-modal-title">Confirmar informações</div>
                    <button className="onb-icon-btn" type="button" onClick={closeReview} aria-label="Fechar">
                      ✕
                    </button>
                  </div>

                  <div className="onb-modal-subtitle">
                    Está tudo certo? Isto ajuda-nos a adaptar comparações e sugestões.
                    <span className="onb-modal-note"> (Vamos criar a sua conta e perfil.)</span>
                  </div>

                  <div className="onb-summary">
                    {summary.map((row) => (
                      <div key={row.id} className="onb-summary-row">
                        <div className="onb-summary-label">{row.label}</div>
                        <div className="onb-summary-value">{row.valueText}</div>
                      </div>
                    ))}
                  </div>

                  {submitError && (
                    <div className="onb-modal-subtitle" style={{ color: '#b42318', marginTop: 10 }}>
                      {submitError}
                    </div>
                  )}

                  <div className="onb-modal-actions">
                    <button className="onb-btn ghost" type="button" onClick={closeReview}>
                      Editar
                    </button>
                    <button className="onb-btn" type="button" onClick={confirmAndContinue} disabled={isSubmitting}>
                      {isSubmitting ? 'A registar…' : 'Confirmar e registar'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="onb-success">
                  <div className="onb-success-icon">✓</div>
                  <div className="onb-success-title">Perfeito, {typeof answers.nome === 'string' && answers.nome.trim() ? answers.nome.split(' ')[0] : 'bem-vindo'}!</div>
                  <div className="onb-success-subtitle">Conta criada. A redirecionar para login…</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Onboarding;
