import React, { useMemo, useState } from 'react';
import logoImg from '../assets/images/logo.png';
import './Dashboard.css';
import './Equipamentos.css';

type MonthOption = { value: string; label: string };

type EquipmentStatus = 'normal' | 'anomalo';

type EquipmentRow = {
  id: string;
  label: string;
  icon: React.ReactNode;
  costLabel: string;
  status: EquipmentStatus;
  barPct: number; // 0-100
};

const monthOptions: MonthOption[] = [
  { value: 'jan', label: 'Janeiro' },
  { value: 'fev', label: 'Fevereiro' },
  { value: 'mar', label: 'Março' },
  { value: 'abr', label: 'Abril' },
  { value: 'mai', label: 'Maio' },
  { value: 'jun', label: 'Junho' },
  { value: 'jul', label: 'Julho' },
  { value: 'ago', label: 'Agosto' },
  { value: 'set', label: 'Setembro' },
  { value: 'out', label: 'Outubro' },
  { value: 'nov', label: 'Novembro' },
  { value: 'dez', label: 'Dezembro' },
];

const navItems = [
  {
    key: 'home',
    label: 'Home',
    href: '/dashboard',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path
          d="M3 9L12 2L21 9V20a2 2 0 0 1-2 2h-5a1 1 0 0 1-1-1v-6H11v6a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V9Z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    key: 'stats',
    label: 'Estatísticas',
    href: '/graficos',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 21V10M12 21V3M19 21v-8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: 'devices',
    label: 'Dispositivos',
    href: '/equipamentos',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8" />
        <path d="M12 16v4" />
      </svg>
    ),
  },
  {
    key: 'profile',
    label: 'Perfil',
    href: '/dashboard',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="7" r="4" />
        <path d="M5 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2" />
      </svg>
    ),
  },
] as const;

function iconFridge() {
  return (
    <svg className="eq-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
      <path d="M7 12h10" />
      <path d="M9 7h.01" />
      <path d="M9 17h.01" />
    </svg>
  );
}

function iconLight() {
  return (
    <svg className="eq-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12c.7.6 1 1.2 1 2h6c0-.8.3-1.4 1-2A7 7 0 0 0 12 2Z" />
    </svg>
  );
}

function iconWaterHeater() {
  return (
    <svg className="eq-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <path d="M9 7h6" />
      <path d="M9 11h6" />
      <path d="M9 15h6" />
    </svg>
  );
}

function iconStandby() {
  return (
    <svg className="eq-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2v10" />
      <path d="M6.2 5.2a8 8 0 1 0 11.3 0" />
    </svg>
  );
}

function iconAc() {
  return (
    <svg className="eq-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="8" rx="2" />
      <path d="M7 16c.5 1.2 1.5 2 3 2s2.5-.8 3-2" />
      <path d="M14 16c.5 1.2 1.5 2 3 2" />
      <path d="M7 20c.5 1 1.5 2 3 2" />
    </svg>
  );
}

function Equipamentos() {
  const [month, setMonth] = useState('jun');

  const rows: EquipmentRow[] = useMemo(
    () => [
      { id: 'fridge', label: 'Frigorífico/Arca', icon: iconFridge(), costLabel: '6.4€', status: 'anomalo', barPct: 92 },
      { id: 'lights', label: 'Luz', icon: iconLight(), costLabel: '0.6€', status: 'normal', barPct: 36 },
      { id: 'water', label: 'Água quente', icon: iconWaterHeater(), costLabel: '1.9€', status: 'normal', barPct: 52 },
      { id: 'standby', label: 'Stand-by', icon: iconStandby(), costLabel: '4.5€', status: 'anomalo', barPct: 78 },
      { id: 'ac', label: 'Ar Condicionado', icon: iconAc(), costLabel: '9.5€', status: 'normal', barPct: 98 },
    ],
    [],
  );

  return (
    <div className="app-shell">
      <div className="phone-frame">
        <header className="top-bar">
          <div className="brand">
            <div className="brand-logo">
              <img src={logoImg} alt="Kynex" />
            </div>
          </div>
          <div className="top-actions">
            <button className="notif-btn" aria-label="Notificações" type="button">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path
                  d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-5-5.9V4a1 1 0 0 0-2 0v1.1A6 6 0 0 0 6 11v3.2c0 .5-.2 1-.6 1.4L4 17h5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M9 17a3 3 0 0 0 6 0" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="notif-badge">2</span>
            </button>
            <button className="avatar-btn" aria-label="Perfil" type="button">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-3.314 3.134-6 7-6h2c3.866 0 7 2.686 7 6" />
              </svg>
            </button>
          </div>
        </header>

        <div className="eq-title">
          <div className="eq-title-small">Os teus</div>
          <div className="eq-title-big">Equipamentos</div>
        </div>

        <main className="content eq-content">
          <section className="eq-consumption-card" aria-label="Consumo por equipamento">
            <div className="eq-consumption-header">
              <div className="eq-consumption-title">Consumo</div>
              <label className="eq-month" aria-label="Selecionar mês">
                <select value={month} onChange={(e) => setMonth(e.target.value)}>
                  {monthOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="eq-rows">
              {rows.map((row) => (
                <div key={row.id} className="eq-row">
                  <div className="eq-row-left">{row.icon}</div>
                  <div className="eq-row-mid">
                    <div className="eq-pill" style={{ width: `${Math.max(20, Math.min(100, row.barPct))}%` }}>
                      <span className="eq-pill-label">{row.label}</span>
                      <span className={`eq-pill-cost ${row.status}`}>{row.costLabel}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="eq-legend" aria-label="Legenda">
              <div className="eq-legend-item">
                <span className="eq-dot normal" /> Normal
              </div>
              <div className="eq-legend-item">
                <span className="eq-dot anomalo" /> Anómalo
              </div>
            </div>
          </section>

          <section className="eq-grid" aria-label="Sugestões e eficiência">
            <div className="eq-mini-card">
              <div className="eq-mini-title">Sugestão do dia</div>
              <div className="eq-mini-body">Máquina de lavar<br />depois das 22h</div>
              <div className="eq-mini-highlight">-0.4 €/ciclo</div>
              <button className="eq-help" type="button" aria-label="Ajuda">?</button>
            </div>

            <div className="eq-mini-card">
              <div className="eq-mini-title">Eficiência</div>
              <div className="eq-gauge" aria-label="Eficiência 71%">
                <div className="eq-gauge-inner">
                  <div className="eq-gauge-value">71%</div>
                </div>
              </div>
              <button className="eq-help" type="button" aria-label="Ajuda">?</button>
            </div>
          </section>
        </main>

        <div className="bottom-nav-wrapper">
          <div className="bottom-nav-container">
            <button className="assistant-cta" aria-label="Assistente IA" type="button">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L15.5 8.5L22 12L15.5 15.5L12 22L8.5 15.5L2 12L8.5 8.5L12 2Z" fill="currentColor" />
              </svg>
            </button>

            <nav className="bottom-nav">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  className={`nav-item ${item.key === 'devices' ? 'active' : ''}`}
                  onClick={() => window.location.assign(item.href)}
                  type="button"
                >
                  {item.icon}
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

export default Equipamentos;
