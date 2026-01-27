import React, { useState, useMemo } from 'react';
import './Notifications.css';

type NotificationType = 'normal' | 'critical';
type NotificationStatus = 'active' | 'archived';

interface Notification {
  id: string;
  title: string;
  message: string;
  timestamp: Date;
  type: NotificationType;
  status: NotificationStatus;
}

// Mock data
const initialNotifications: Notification[] = [
  {
    id: '1',
    title: 'Risco de Disparo',
    message: 'Consumo atual: 6.8 kVA. O quadro vai abaixo se ligar mais algo.',
    timestamp: new Date(Date.now() - 5 * 60 * 1000),
    type: 'critical',
    status: 'active',
  },
  {
    id: '2',
    title: 'Alerta de Segurança',
    message: 'Fogão ligado há 3 horas (fora do padrão). Verifique urgentemente.',
    timestamp: new Date(Date.now() - 15 * 60 * 1000),
    type: 'critical',
    status: 'active',
  },
  {
    id: '3',
    title: 'Active Guardian',
    message: 'Sem atividade detetada na casa "Avós" há 4 horas. Contacte.',
    timestamp: new Date(Date.now() - 45 * 60 * 1000),
    type: 'critical',
    status: 'active',
  },
  {
    id: '4',
    title: 'Hora de Lavar',
    message: 'Espere até às 22h para ligar a máquina. Poupa 60% na lavagem.',
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000),
    type: 'normal',
    status: 'active',
  },
  {
    id: '5',
    title: 'Orçamento Atingido',
    message: 'Atenção: Já ultrapassou o limite definido para o mês atual.',
    timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000),
    type: 'normal',
    status: 'active',
  },
  {
    id: '6',
    title: 'Relatório Semanal',
    message: 'Boa notícia! Esta semana consumiu menos 15% que na anterior.',
    timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000),
    type: 'normal',
    status: 'active',
  },
];

const Notifications: React.FC = () => {
  const [notifications, setNotifications] = useState<Notification[]>(initialNotifications);
  const [activeTab, setActiveTab] = useState<'active' | 'archived'>('active');
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const [swipeDirection, setSwipeDirection] = useState<'left' | 'right' | null>(null);
  const [showHint, setShowHint] = useState<boolean>(() => {
    try {
      return !localStorage.getItem('kynex:notificationHintSeen');
    } catch {
      return true;
    }
  });

  // Calculate unread count (active notifications)
  const unreadCount = useMemo(() => {
    const count = notifications.filter((n) => n.status === 'active').length;
    // Update localStorage for other pages to read
    try {
      localStorage.setItem('kynex:notificationCount', count.toString());
      // Dispatch event for real-time updates
      window.dispatchEvent(new Event('notificationCountChanged'));
    } catch (e) {
      console.error('Failed to update notification count', e);
    }
    return count;
  }, [notifications]);

  // Filter notifications based on active tab
  const filteredNotifications = useMemo(() => {
    return notifications.filter((n) => n.status === activeTab);
  }, [notifications, activeTab]);

  // Format timestamp
  const formatTimestamp = (date: Date): string => {
    const now = Date.now();
    const diff = now - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'agora';
    if (minutes < 60) return `${minutes} min atrás`;
    if (hours < 24) return `${hours}h atrás`;
    return `${days}d atrás`;
  };

  // Handle swipe left (dismiss/archive)
  const handleSwipeLeft = (notification: Notification) => {
    if (notification.type === 'normal') {
      // Delete permanently
      setNotifications((prev) => prev.filter((n) => n.id !== notification.id));
    } else {
      // Move to archived
      setNotifications((prev) =>
        prev.map((n) => (n.id === notification.id ? { ...n, status: 'archived' as NotificationStatus } : n))
      );
    }
    setSwipedId(null);
    setSwipeDirection(null);
  };

  // Handle notification click
  const handleNotificationClick = (notification: Notification) => {
    // Only critical notifications navigate to security page
    if (notification.type === 'critical') {
      window.location.assign('/seguranca');
    }
    // Normal notifications do nothing on click
  };

  // Mouse/Touch handlers for swipe gesture
  const handleTouchStart = (e: React.TouchEvent | React.MouseEvent, id: string) => {
    const startX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const element = e.currentTarget as HTMLElement;

    const handleMove = (moveEvent: TouchEvent | MouseEvent) => {
      const currentX = 'touches' in moveEvent ? moveEvent.touches[0].clientX : moveEvent.clientX;
      const diff = currentX - startX;

      // Only allow swiping right (positive diff)
      if (diff > 20) {
        setSwipedId(id);
        setSwipeDirection('right');
      }

      // Apply transform only for right swipe
      if (diff > 0 && diff < 150) {
        element.style.transform = `translateX(${diff}px)`;
      }
    };

    const handleEnd = (endEvent: TouchEvent | MouseEvent) => {
      const currentX = 'touches' in endEvent ? endEvent.changedTouches[0].clientX : endEvent.clientX;
      const diff = currentX - startX;

      // Only trigger action if swiped right beyond threshold
      if (diff > 100) {
        const notification = notifications.find((n) => n.id === id);
        if (notification) {
          handleSwipeLeft(notification);
        }
      }

      element.style.transform = '';
      setSwipedId(null);
      setSwipeDirection(null);
      document.removeEventListener('touchmove', handleMove as any);
      document.removeEventListener('touchend', handleEnd as any);
      document.removeEventListener('mousemove', handleMove as any);
      document.removeEventListener('mouseup', handleEnd as any);
    };

    document.addEventListener('touchmove', handleMove as any);
    document.addEventListener('touchend', handleEnd as any);
    document.addEventListener('mousemove', handleMove as any);
    document.addEventListener('mouseup', handleEnd as any);
  };

  return (
    <div className="notifications-container">
      {/* Header */}
      <div className="notifications-header">
        <button className="back-button" onClick={() => window.history.back()} aria-label="Voltar">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1>Notificações</h1>
        {unreadCount > 0 && <span className="unread-badge">{unreadCount}</span>}
      </div>

      {/* Swipe Hint */}
      {showHint && (
        <div className="swipe-hint-card" onClick={() => {
          setShowHint(false);
          try {
            localStorage.setItem('kynex:notificationHintSeen', 'true');
          } catch (e) {
            console.error('Failed to save hint state', e);
          }
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Deslize para a direita para eliminar</span>
          <button className="hint-close">✕</button>
        </div>
      )}

      {/* Tabs */}
      <div className="notifications-tabs">
        <button
          className={`tab ${activeTab === 'active' ? 'active' : ''}`}
          onClick={() => setActiveTab('active')}
        >
          Ativos
        </button>
        <button
          className={`tab ${activeTab === 'archived' ? 'active' : ''}`}
          onClick={() => setActiveTab('archived')}
        >
          Arquivados
        </button>
      </div>

      {/* Notifications List */}
      <div className="notifications-list">
        {filteredNotifications.length === 0 ? (
          <div className="empty-state">
            <p>Sem notificações {activeTab === 'active' ? 'ativas' : 'arquivadas'}</p>
          </div>
        ) : (
          filteredNotifications.map((notification) => (
            <div
              key={notification.id}
              className="notification-wrapper"
              onTouchStart={(e) => handleTouchStart(e, notification.id)}
              onMouseDown={(e) => handleTouchStart(e, notification.id)}
            >
              {/* Swipe Actions Background */}
              <div className="swipe-actions">
                <div className="swipe-action-left">
                  {notification.type === 'normal' ? (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  ) : (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                      <path d="M16 11l5 5M21 11l-5 5" />
                    </svg>
                  )}
                </div>
              </div>

              {/* Notification Card */}
              <div 
                className={`notification-card ${notification.type} ${notification.title === 'Hora de Lavar' ? 'ai-notification' : ''}`}
                onClick={() => handleNotificationClick(notification)}
                style={{ cursor: notification.type === 'critical' ? 'pointer' : 'default' }}
              >
                <div className="notification-icon">
                  {notification.type === 'critical' ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                  ) : notification.title === 'Hora de Lavar' ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                      <path d="M12 2L15.5 8.5L22 12L15.5 15.5L12 22L8.5 15.5L2 12L8.5 8.5L12 2Z" fill="currentColor" />
                    </svg>
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    </svg>
                  )}
                </div>
                <div className="notification-content">
                  <h3 className="notification-title">{notification.title}</h3>
                  <p className="notification-message">{notification.message}</p>
                  <span className="notification-timestamp">{formatTimestamp(notification.timestamp)}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default Notifications;
