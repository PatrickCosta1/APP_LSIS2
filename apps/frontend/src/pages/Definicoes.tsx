import React, { useEffect, useState } from 'react';
import logoImg from '../assets/images/logo2.png';
import SettingsDrawer from '../components/SettingsDrawer';
import './Definicoes.css';

function IconBack() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
    </svg>
  );
}

function IconBrain() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 4.5a2.5 2.5 0 0 0-4.96-.46 2.5 2.5 0 0 0-1.98 3 2.5 2.5 0 0 0-1.32 4.24 3 3 0 0 0 .34 5.58 2.5 2.5 0 0 0 2.96 3.08 2.5 2.5 0 0 0 4.91.05L12 20V4.5ZM16 8V5c0-1.1.9-2 2-2M17 14v3c0 1.1-.9 2-2 2" />
    </svg>
  );
}

function IconPlug() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2v4M7 6v4M17 6v4M10 10v11c0 1.1.9 2 2 2s2-.9 2-2V10" />
    </svg>
  );
}

export default function Definicoes() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customerName, setCustomerName] = useState<string>('Cliente');
  const [userEmail, setUserEmail] = useState<string>('');
  const [userPhotoUrl, setUserPhotoUrl] = useState<string | null>(null);

  // Estados de configuração
  const [billingDay, setBillingDay] = useState(1);
  const [contractedPower, setContractedPower] = useState(6.9);
  const [tariff, setTariff] = useState('Bi-horário');
  const [aiSensitivity, setAiSensitivity] = useState(50); // 0-100
  const [phantomDetection, setPhantomDetection] = useState(true);
  const [budgetLimit, setBudgetLimit] = useState(50);

  // Notificações
  const [securityAlerts, setSecurityAlerts] = useState(true);
  const [weeklyReport, setWeeklyReport] = useState(false);
  const [savingsTips, setSavingsTips] = useState(true);
  const [powerWarnings, setPowerWarnings] = useState(false);

  // Modais de edição
  const [showBillingDayModal, setShowBillingDayModal] = useState(false);
  const [showBudgetModal, setShowBudgetModal] = useState(false);
  const [tempBillingDay, setTempBillingDay] = useState(billingDay);
  const [tempBudgetLimit, setTempBudgetLimit] = useState(budgetLimit);

  useEffect(() => {
    try {
      // Verifica se deve abrir o menu ao retornar de uma página de configurações
      const shouldOpenSettings = localStorage.getItem('openSettingsOnReturn');
      if (shouldOpenSettings === 'true') {
        localStorage.removeItem('openSettingsOnReturn');
        setSettingsOpen(true);
      }
    } catch {
      // ignore
    }
  }, []);

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

  const getSensitivityLabel = (value: number) => {
    if (value < 33) return 'Baixa';
    if (value < 66) return 'Média';
    return 'Alta';
  };

  const handleSaveBillingDay = () => {
    if (tempBillingDay >= 1 && tempBillingDay <= 31) {
      setBillingDay(tempBillingDay);
      setShowBillingDayModal(false);
    }
  };

  const handleSaveBudget = () => {
    if (tempBudgetLimit > 0) {
      setBudgetLimit(tempBudgetLimit);
      setShowBudgetModal(false);
    }
  };

  const handleGoToContract = () => {
    window.location.href = '/contrato';
  };

  const handleLogout = () => {
    if (window.confirm('Tem a certeza que deseja terminar a sessão?')) {
      localStorage.clear();
      window.location.href = '/login';
    }
  };

  return (
    <div className="app-shell">
      <div className="phone-frame definicoes-frame">
        <header className="top-bar">
          <div className="brand">
            <div className="brand-logo">
              <img src={logoImg} alt="Kynex" />
            </div>
          </div>
          <div className="definicoes-actions">
            <button
              className="definicoes-back"
              type="button"
              onClick={() => {
                localStorage.setItem('openSettingsOnReturn', 'true');
                window.history.back();
              }}
              aria-label="Voltar"
            >
              <IconBack />
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

        <main className="content definicoes-content">
          <div className="definicoes-page-title">Preferências do Sistema</div>

          {/* Secção: Energia & Contrato */}
          <div className="settings-section">
            <div className="section-header">
              <IconBolt />
              <span>Energia & Contrato</span>
            </div>
            <div className="settings-group">
              <div className="settings-row clickable" onClick={() => {
                setTempBillingDay(billingDay);
                setShowBillingDayModal(true);
              }}>
                <div className="row-label">Dia de Faturação</div>
                <div className="row-value">
                  Dia {billingDay.toString().padStart(2, '0')}
                  <IconChevronRight />
                </div>
              </div>
              <div className="settings-row">
                <div className="row-label">
                  <div>Potência Contratada</div>
                  <div className="row-sublabel">Definido no contrato</div>
                </div>
                <div className="row-value-fixed">
                  {contractedPower} kVA
                </div>
              </div>
              <div className="settings-row">
                <div className="row-label">Tarifário</div>
                <div className="row-value-fixed">
                  {tariff}
                </div>
              </div>
              <button className="contract-change-btn" onClick={handleGoToContract}>
                Ver e Alterar Contrato
              </button>
            </div>
          </div>

          {/* Secção: Inteligência Artificial */}
          <div className="settings-section ai-section">
            <div className="section-header">
              <IconBrain />
              <span>Inteligência Artificial</span>
              <span className="pro-badge">PRO</span>
            </div>
            <div className="settings-group">
              <div className="settings-row-full">
                <div className="slider-container">
                  <div className="slider-header">
                    <span className="slider-label">Sensibilidade de Alertas</span>
                    <span className="slider-value">{getSensitivityLabel(aiSensitivity)}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={aiSensitivity}
                    onChange={(e) => setAiSensitivity(Number(e.target.value))}
                    className="ai-slider"
                  />
                  <div className="slider-legend">
                    <span>Baixa</span>
                    <span>Alta</span>
                  </div>
                </div>
              </div>

              <div className="settings-row">
                <div className="row-label">
                  <div>Deteção de Consumo Fantasma</div>
                  <div className="row-sublabel">Identifica dispositivos em standby</div>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={phantomDetection}
                    onChange={(e) => setPhantomDetection(e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              <div className="settings-row clickable" onClick={() => {
                setTempBudgetLimit(budgetLimit);
                setShowBudgetModal(true);
              }}>
                <div className="row-label">Limite de Orçamento</div>
                <div className="row-value">
                  {budgetLimit}€/mês
                  <IconChevronRight />
                </div>
              </div>
            </div>
          </div>

          {/* Secção: Hardware Conectado */}
          <div className="settings-section">
            <div className="section-header">
              <IconPlug />
              <span>Hardware Conectado</span>
            </div>
            <div className="settings-group">
              <div className="device-item">
                <div className="device-icon">
                  <IconPlug />
                </div>
                <div className="device-info">
                  <div className="device-name">Kynex Node</div>
                  <div className="device-status">
                    <span className="status-indicator online"></span>
                    Online
                  </div>
                </div>
              </div>
              <div className="device-item">
                <div className="device-icon">
                  <IconPlug />
                </div>
                <div className="device-info">
                  <div className="device-name">Kynex Plug (Frigorífico)</div>
                  <div className="device-status">
                    <span className="status-indicator online"></span>
                    Online
                  </div>
                </div>
              </div>
              <button className="add-device-btn">+ Adicionar Equipamento</button>
            </div>
          </div>

          {/* Secção: Notificações */}
          <div className="settings-section">
            <div className="section-header">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <span>Notificações</span>
            </div>
            <div className="settings-group">
              <div className="settings-row">
                <div className="row-label">
                  <div>Alertas de Segurança</div>
                  <div className="row-sublabel critical">Crítico</div>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={securityAlerts}
                    onChange={(e) => setSecurityAlerts(e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              <div className="settings-row">
                <div className="row-label">Resumo Semanal (Email)</div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={weeklyReport}
                    onChange={(e) => setWeeklyReport(e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              <div className="settings-row">
                <div className="row-label">Dicas de Poupança (Push)</div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={savingsTips}
                    onChange={(e) => setSavingsTips(e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              <div className="settings-row">
                <div className="row-label">Avisos de Potência</div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={powerWarnings}
                    onChange={(e) => setPowerWarnings(e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>
            </div>
          </div>

          {/* Rodapé */}
          <div className="settings-footer">
            <button className="logout-btn" onClick={handleLogout}>
              Terminar Sessão
            </button>
            <div className="version-info">Versão 2.1.0 (Build 402)</div>
          </div>
        </main>

        {/* Modal: Editar Dia de Faturação */}
        {showBillingDayModal && (
          <div className="modal-overlay" onClick={() => setShowBillingDayModal(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Dia de Faturação</h3>
                <button className="modal-close" onClick={() => setShowBillingDayModal(false)}>×</button>
              </div>
              <div className="modal-body">
                <p className="modal-description">Escolha o dia do mês em que a sua fatura reseta:</p>
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={tempBillingDay}
                  onChange={(e) => setTempBillingDay(Number(e.target.value))}
                  className="modal-input"
                  placeholder="1-31"
                />
              </div>
              <div className="modal-footer">
                <button className="modal-btn-cancel" onClick={() => setShowBillingDayModal(false)}>
                  Cancelar
                </button>
                <button className="modal-btn-save" onClick={handleSaveBillingDay}>
                  Guardar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal: Editar Limite de Orçamento */}
        {showBudgetModal && (
          <div className="modal-overlay" onClick={() => setShowBudgetModal(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Limite de Orçamento</h3>
                <button className="modal-close" onClick={() => setShowBudgetModal(false)}>×</button>
              </div>
              <div className="modal-body">
                <p className="modal-description">Defina o valor máximo mensal que deseja gastar:</p>
                <div className="input-with-currency">
                  <input
                    type="number"
                    min="1"
                    value={tempBudgetLimit}
                    onChange={(e) => setTempBudgetLimit(Number(e.target.value))}
                    className="modal-input"
                    placeholder="50"
                  />
                  <span className="currency-symbol">€/mês</span>
                </div>
              </div>
              <div className="modal-footer">
                <button className="modal-btn-cancel" onClick={() => setShowBudgetModal(false)}>
                  Cancelar
                </button>
                <button className="modal-btn-save" onClick={handleSaveBudget}>
                  Guardar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
