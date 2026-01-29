import { useState, useEffect } from 'react';

// Corrige: lê diretamente as notificações do localStorage e calcula o número de ativas ao montar
export const useNotificationCount = (): number => {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    const updateCount = () => {
      try {
        const raw = localStorage.getItem('kynex:notifications');
        if (raw) {
          const arr = JSON.parse(raw);
          const active = Array.isArray(arr) ? arr.filter((n) => n.status === 'active').length : 0;
          setCount(active);
        } else {
          setCount(0);
        }
      } catch {
        setCount(0);
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
