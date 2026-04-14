import { useEffect, useCallback, useState } from 'react';
import { StockState } from '../types';

interface UseNotificationsResult {
  hasPermission: boolean;
  requestPermission: () => Promise<void>;
}

export function useNotifications(
  alerts: StockState[],
  clearAlert: (symbol: string) => void
): UseNotificationsResult {
  const [hasPermission, setHasPermission] = useState(false);

  useEffect(() => {
    if ('Notification' in window) {
      setHasPermission(Notification.permission === 'granted');
    }
  }, []);

  const requestPermission = useCallback(async () => {
    if (!('Notification' in window)) {
      console.warn('Browser does not support notifications');
      return;
    }

    const permission = await Notification.requestPermission();
    setHasPermission(permission === 'granted');
  }, []);

  useEffect(() => {
    if (!hasPermission || alerts.length === 0) {
      return;
    }

    for (const alert of alerts) {
      const hasTarget = alert.targetPrice > 0;
      const notification = new Notification(`Price Alert: ${alert.symbol}`, {
        body: hasTarget
          ? `${alert.symbol} at $${alert.currentPrice?.toFixed(2)} (target: $${alert.targetPrice.toFixed(2)})`
          : `${alert.symbol} at $${alert.currentPrice?.toFixed(2)}`,
        icon: '/vite.svg',
        tag: `alert-${alert.symbol}`,
        requireInteraction: true,
      });

      notification.onclick = () => {
        window.focus();
        window.open(`https://robinhood.com/stocks/${alert.symbol}`, '_blank');
        notification.close();
      };

      notification.onclose = () => {
        clearAlert(alert.symbol);
      };

      // Auto-close after 30 seconds
      setTimeout(() => {
        notification.close();
      }, 30000);
    }
  }, [alerts, hasPermission, clearAlert]);

  return {
    hasPermission,
    requestPermission,
  };
}
