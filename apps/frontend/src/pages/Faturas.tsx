import React, { useEffect, useMemo, useRef, useState } from 'react';
import logoImg from '../assets/images/logo2.png';
import SettingsDrawer from '../components/SettingsDrawer';
import './Faturas.css';

function IconBack() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function IconDocument() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

function IconCamera() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l2-3h8l2 3h3a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
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

type Invoice = {
  id: string;
  filename: string;
  uploaded_at: string;
  utility_guess?: string;
  valor_pagar_eur?: number;
  potencia_contratada_kva?: number;
  termo_energia_eur?: number;
  termo_potencia_eur?: number;
  analysis?: {
    consumption_kwh_year: number;
    current_cost_year_eur: number;
    best_cost_year_eur: number;
    savings_year_eur: number;
    top: Array<{ comercializador: string; nome_proposta: string; cost_year_eur: number; savings_year_eur: number }>;
  };
};

export default function Faturas() {
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customerName, setCustomerName] = useState<string>('Cliente');
  const [userEmail, setUserEmail] = useState<string>('');
  const [userPhotoUrl, setUserPhotoUrl] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [contractHintVisible, setContractHintVisible] = useState(false);

  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  const [cameraMode, setCameraMode] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraCaptureInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const pendingKind = useMemo(() => {
    if (!pendingFile) return null;
    const type = pendingFile.type || '';
    if (type.startsWith('image/')) return 'image' as const;
    if (type === 'application/pdf' || pendingFile.name.toLowerCase().endsWith('.pdf')) return 'pdf' as const;
    return 'other' as const;
  }, [pendingFile]);

  const canLiveCamera = useMemo(() => {
    try {
      return Boolean((window as any).isSecureContext && navigator.mediaDevices?.getUserMedia);
    } catch {
      return false;
    }
  }, []);

  const isLikelyMobile = useMemo(() => {
    try {
      const uaMobile = Boolean((navigator as any).userAgentData?.mobile);
      if (uaMobile) return true;
      // fallback heuristics
      const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)').matches : false;
      if (coarse) return true;
      const ua = (navigator.userAgent || '').toLowerCase();
      return /android|iphone|ipad|ipod|mobile/.test(ua);
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    try {
      const id = localStorage.getItem('kynex:customerId');
      setCustomerId(id);

      const hint = localStorage.getItem('kynex:contractAnalysisHint');
      if (hint === '1') setContractHintVisible(true);

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
    const apiBases = [(import.meta as any).env?.VITE_API_BASE as string | undefined, 'http://localhost:4100'].filter(Boolean) as string[];
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
    if (!apiBase || !customerId) return;
    let cancelled = false;

    async function loadInvoices() {
      setLoading(true);
      try {
        const token = localStorage.getItem('kynex:authToken');
        const res = await fetch(`${apiBase}/customers/${customerId}/invoices`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });
        if (!res.ok) throw new Error('invoices');
        const json = (await res.json()) as { items: Invoice[] };
        if (!cancelled) setInvoices(Array.isArray(json.items) ? json.items : []);
      } catch (err) {
        console.error('Error loading invoices:', err);
        if (!cancelled) setInvoices([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadInvoices();
    return () => {
      cancelled = true;
    };
  }, [apiBase, customerId]);

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

  const stopCamera = () => {
    const s = cameraStreamRef.current;
    if (s) {
      for (const track of s.getTracks()) track.stop();
    }
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const closeUploadModal = () => {
    stopCamera();
    setCameraMode(false);
    setCameraError(null);
    setPendingFile(null);
    setUploadModalOpen(false);
  };

  useEffect(() => {
    if (!pendingPreviewUrl) return;
    return () => {
      try {
        URL.revokeObjectURL(pendingPreviewUrl);
      } catch {
        // ignore
      }
    };
  }, [pendingPreviewUrl]);

  useEffect(() => {
    if (!cameraMode) return;
    const stream = cameraStreamRef.current;
    const video = videoRef.current;
    if (!stream || !video) return;

    if (video.srcObject !== stream) video.srcObject = stream;
    void video.play().catch(() => {
      // alguns browsers exigem nova interação do utilizador
    });
  }, [cameraMode]);

  useEffect(() => {
    if (!uploadModalOpen) {
      stopCamera();
      setCameraMode(false);
      setCameraError(null);
      setPendingFile(null);
      if (pendingPreviewUrl) setPendingPreviewUrl(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadModalOpen]);

  const handleUploadClick = () => {
    setUploadModalOpen(true);
    setPendingFile(null);
    setCameraMode(false);
    setCameraError(null);
    if (pendingPreviewUrl) setPendingPreviewUrl(null);
  };

  const onPickedFile = (file: File) => {
    if (pendingPreviewUrl) {
      try {
        URL.revokeObjectURL(pendingPreviewUrl);
      } catch {
        // ignore
      }
    }
    setPendingFile(file);
    if (file.type.startsWith('image/')) setPendingPreviewUrl(URL.createObjectURL(file));
    else setPendingPreviewUrl(null);
  };

  const startCamera = async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('O seu dispositivo/navegador não suporta acesso à câmara.');
      return;
    }

    if (!(window as any).isSecureContext) {
      setCameraError('A câmara só funciona em HTTPS.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      cameraStreamRef.current = stream;
      setCameraMode(true);
    } catch (e) {
      console.error('Camera error:', e);
      setCameraError('Não foi possível aceder à câmara. Verifique permissões no browser.');
      // fallback apenas em mobile (input capture abre picker no desktop)
      if (isLikelyMobile) cameraCaptureInputRef.current?.click();
    }
  };

  const captureFromCamera = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const w = Math.max(1, video.videoWidth || 0);
    const h = Math.max(1, video.videoHeight || 0);
    if (!w || !h) return;

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);

    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9));
    if (!blob) return;

    const stamp = new Date().toISOString().slice(0, 10);
    const file = new File([blob], `fatura_${stamp}.jpg`, { type: 'image/jpeg' });
    stopCamera();
    setCameraMode(false);
    onPickedFile(file);
  };

  const confirmUpload = async () => {
    const file = pendingFile;
    if (!file) return;
    if (!apiBase || !customerId) return;

    try {
      setUploading(true);
      const token = localStorage.getItem('kynex:authToken');

      const form = new FormData();
      form.append('file', file);

      const res = await fetch(`${apiBase}/customers/${customerId}/invoices`, {
        method: 'POST',
        body: form,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      });
      if (!res.ok) throw new Error('upload');

      try {
        localStorage.setItem('kynex:contractAnalysisHint', '1');
        setContractHintVisible(true);
      } catch {
        // ignore
      }

      const listRes = await fetch(`${apiBase}/customers/${customerId}/invoices`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      });
      if (listRes.ok) {
        const json = (await listRes.json()) as { items: Invoice[] };
        setInvoices(Array.isArray(json.items) ? json.items : []);
      }

      setUploadModalOpen(false);
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
    }
  };

  const getStatusBadgeClass = (invoice: Invoice) => {
    const s = invoice.analysis?.savings_year_eur;
    if (typeof s !== 'number') return 'badge-due';
    if (s > 0.5) return 'badge-due';
    return 'badge-warning';
  };

  const getStatusText = (invoice: Invoice) => {
    const s = invoice.analysis?.savings_year_eur;
    if (typeof s !== 'number') return 'Sem análise';
    if (s > 0.5) return `✅ Poupa ${Math.round(s)}€/ano`;
    return 'Sem poupança';
  };

  const fmtUploaded = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short' });
  };

  return (
    <div className="app-shell">
      <div className="phone-frame faturas-frame">
        <header className="top-bar">
          <div className="brand">
            <button className="brand-logo" type="button" onClick={() => window.location.assign('/dashboard')} aria-label="Ir para Dashboard">
              <img src={logoImg} alt="Kynex" />
            </button>
          </div>
          <div className="faturas-actions">
            <button
              className="faturas-back"
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

        <main className="content faturas-content">
          <div className="faturas-page-title">Arquivo de Faturas</div>
          <div className="faturas-subtitle">Histórico e validação</div>

          {contractHintVisible && (
            <div className="contract-hint">
              <div className="contract-hint-title">Análise contratual disponível</div>
              <div className="contract-hint-text" style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 10 }}>
                A informação do seu contrato foi atualizada com base na sua última fatura. Veja os detalhes na página Contrato.
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="contract-hint-btn"
                  style={{
                    background: '#00CED1',
                    border: 'none',
                    color: '#061018',
                    fontWeight: 800,
                    borderRadius: 12,
                    padding: '10px 12px',
                    cursor: 'pointer'
                  }}
                  onClick={() => window.location.assign('/contrato')}
                >
                  Ir para Contrato
                </button>
                <button
                  type="button"
                  className="contract-hint-close"
                  style={{
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    color: '#fff',
                    fontWeight: 700,
                    borderRadius: 12,
                    padding: '10px 12px',
                    cursor: 'pointer'
                  }}
                  onClick={() => {
                    setContractHintVisible(false);
                    try {
                      localStorage.removeItem('kynex:contractAnalysisHint');
                    } catch {
                      // ignore
                    }
                  }}
                >
                  Fechar
                </button>
              </div>
            </div>
          )}

          {/* Hero Section - Upload */}
          <div className="upload-hero" onClick={handleUploadClick}>
            <div className="upload-icon-wrapper">
              <IconUpload />
            </div>
            <div className="upload-text">
              <div className="upload-main-text">Carregar Nova Fatura</div>
              <div className="upload-sub-text">{uploading ? 'A enviar…' : 'PDF ou Imagem'}</div>
            </div>
          </div>

          {uploadModalOpen && (
            <div className="invoice-upload-modal" role="dialog" aria-modal="true" aria-label="Carregar nova fatura">
              <div className="invoice-upload-backdrop" onClick={() => (!uploading ? closeUploadModal() : undefined)} />
              <div className="invoice-upload-card">
                <div className="invoice-upload-title">Carregar nova fatura</div>
                <div className="invoice-upload-subtitle">Escolha um PDF, uma imagem, ou tire uma foto agora.</div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    onPickedFile(file);
                    e.currentTarget.value = '';
                  }}
                />

                <input
                  ref={cameraCaptureInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    onPickedFile(file);
                    e.currentTarget.value = '';
                  }}
                />

                {!pendingFile && !cameraMode && (
                  <div className="invoice-upload-actions">
                    <button type="button" className="invoice-upload-btn primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                      <IconDocument />
                      <span>Escolher PDF/Imagem</span>
                    </button>
                    {canLiveCamera ? (
                      <button type="button" className="invoice-upload-btn" onClick={startCamera} disabled={uploading}>
                        <IconCamera />
                        <span>Tirar foto</span>
                      </button>
                    ) : isLikelyMobile ? (
                      <button type="button" className="invoice-upload-btn" onClick={() => cameraCaptureInputRef.current?.click()} disabled={uploading}>
                        <IconCamera />
                        <span>Tirar foto</span>
                      </button>
                    ) : null}
                    {cameraError && <div className="invoice-upload-error">{cameraError}</div>}
                  </div>
                )}

                {cameraMode && (
                  <div className="invoice-camera">
                    <video ref={videoRef} className="invoice-camera-video" playsInline muted />
                    <canvas ref={canvasRef} style={{ display: 'none' }} />
                    <div className="invoice-upload-footer">
                      <button type="button" className="invoice-upload-footer-btn" onClick={() => (!uploading ? closeUploadModal() : undefined)} disabled={uploading}>
                        Cancelar
                      </button>
                      <button type="button" className="invoice-upload-footer-btn primary" onClick={captureFromCamera} disabled={uploading}>
                        Capturar
                      </button>
                    </div>
                    {cameraError && <div className="invoice-upload-error">{cameraError}</div>}
                  </div>
                )}

                {pendingFile && !cameraMode && (
                  <div className="invoice-upload-preview">
                    {pendingKind === 'image' && pendingPreviewUrl && (
                      <img className="invoice-preview-img" src={pendingPreviewUrl} alt="Pré-visualização da fatura" />
                    )}
                    {pendingKind !== 'image' && (
                      <div className="invoice-preview-file">
                        <div className="invoice-preview-file-icon">
                          <IconDocument />
                        </div>
                        <div className="invoice-preview-file-name" title={pendingFile.name}>
                          {pendingFile.name}
                        </div>
                      </div>
                    )}
                    <div className="invoice-upload-footer">
                      <button type="button" className="invoice-upload-footer-btn" onClick={() => (!uploading ? closeUploadModal() : undefined)} disabled={uploading}>
                        Cancelar
                      </button>
                      <button type="button" className="invoice-upload-footer-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                        Trocar
                      </button>
                      <button
                        type="button"
                        className="invoice-upload-footer-btn primary"
                        onClick={confirmUpload}
                        disabled={uploading || !apiBase || !customerId}
                        title={!apiBase || !customerId ? 'Sem ligação ao servidor' : undefined}
                      >
                        {uploading ? 'A enviar…' : 'Confirmar'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Lista de Histórico */}
          <div className="invoices-section">
            <div className="section-title">Recentes</div>
            
            <div className="invoices-list">
              {loading && <div className="invoice-item">A carregar…</div>}
              {!loading && invoices.length === 0 && <div className="invoice-item">Sem faturas ainda</div>}
              {!loading && invoices.map((invoice) => (
                <div key={invoice.id} className="invoice-item">
                  <div className="invoice-icon">
                    <IconBolt />
                  </div>
                  
                  <div className="invoice-info">
                    <div className="invoice-header">
                      <span className="invoice-reference" title={invoice.filename || 'Fatura'}>{invoice.filename || 'Fatura'}</span>
                      {invoice.analysis && <span className="ai-badge">✨</span>}
                    </div>
                    <div className="invoice-details">
                      <span className="invoice-provider" title={invoice.utility_guess || '—'}>{invoice.utility_guess ?? '—'}</span>
                      <span className="invoice-separator">•</span>
                      <span className="invoice-date">{fmtUploaded(invoice.uploaded_at)}</span>
                    </div>
                  </div>

                  <div className="invoice-right">
                    <div className="invoice-amount">{typeof invoice.valor_pagar_eur === 'number' ? invoice.valor_pagar_eur.toFixed(2) + '€' : '—'}</div>
                    <div className={`invoice-badge ${getStatusBadgeClass(invoice)}`}>
                      {getStatusText(invoice)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
