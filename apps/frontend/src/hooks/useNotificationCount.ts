import { useState, useEffect } from 'react';

const DEFAULT_NOTIFICATION_COUNT = 6;

// Corrige: lê diretamente as notificações do localStorage e calcula o número de ativas ao montar
export const useNotificationCount = (): number => {
  const [count, setCount] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('kynex:notificationCount');
      return stored ? parseInt(stored, 10) : DEFAULT_NOTIFICATION_COUNT;
    } catch {
      return DEFAULT_NOTIFICATION_COUNT;
    }
  });

  useEffect(() => {
    const updateCount = () => {
      try {
        const stored = localStorage.getItem('kynex:notificationCount');
        if (stored == null) {
          localStorage.setItem('kynex:notificationCount', String(DEFAULT_NOTIFICATION_COUNT));
          setCount(DEFAULT_NOTIFICATION_COUNT);
          window.dispatchEvent(new Event('notificationCountChanged'));
          return;
        }
        setCount(stored ? parseInt(stored, 10) : DEFAULT_NOTIFICATION_COUNT);
      } catch {
        setCount(DEFAULT_NOTIFICATION_COUNT);
      }
    };
    updateCount(); // Atualiza ao montar
    window.addEventListener('notificationCountChanged', updateCount);
    window.addEventListener('storage', updateCount);
    return () => {
      window.removeEventListener('notificationCountChanged', updateCount);
      window.removeEventListener('storage', updateCount);
    };
  }, []);
  return count;
};
