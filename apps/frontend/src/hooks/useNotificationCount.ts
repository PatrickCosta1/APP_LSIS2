import { useState, useEffect } from 'react';

export const useNotificationCount = (): number => {
  const [count, setCount] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('kynex:notificationCount');
      return stored ? parseInt(stored, 10) : 0;
    } catch {
      return 0;
    }
  });

  useEffect(() => {
    const updateCount = () => {
      try {
        const stored = localStorage.getItem('kynex:notificationCount');
        setCount(stored ? parseInt(stored, 10) : 0);
      } catch {
        setCount(0);
      }
    };

    // Listen for changes
    window.addEventListener('notificationCountChanged', updateCount);
    window.addEventListener('storage', updateCount);

    return () => {
      window.removeEventListener('notificationCountChanged', updateCount);
      window.removeEventListener('storage', updateCount);
    };
  }, []);

  return count;
};
