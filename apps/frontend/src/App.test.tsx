import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import App from './App';

const mockFetch = () => {
  const handlers: Record<string, unknown> = {
    '/health': { status: 'ok' },
    '/customers/:id/telemetry/now': {
      customerId: 'U_test',
      name: 'Susana',
      lastUpdated: new Date().toISOString(),
      wattsNow: 820,
      avgWattsLastHour: 640,
      kwhLast24h: 12.04,
      eurosLast24h: 2.23,
      monthToDateKwh: 120.55,
      monthToDateEuros: 22.31,
      forecastMonthKwh: 330.0,
      forecastMonthEuros: 61.05,
      similarKwhLast24h: 14.02,
      similarDeltaPct: -14.1,
      priceEurPerKwh: 0.185
    },
    '/customers/:id/chart': {
      title: 'Consumo',
      items: [
        { label: 'Seg', value: 10.2, kind: 'consumido' },
        { label: 'Ter', value: 11.1, kind: 'consumido' },
        { label: 'Qua', value: 12.0, kind: 'consumido' }
      ]
    },
    'https://api.ipma.pt/open-data/weather-type-classe.json': {
      data: [{ idWeatherType: 1, descWeatherTypePT: 'Céu limpo' }]
    },
    'https://api.ipma.pt/open-data/forecast/meteorology/cities/daily/1131200.json': {
      data: [{ forecastDate: '2026-01-19', tMax: '18', tMin: '9', idWeatherType: 1 }],
      globalIdLocal: 1131200,
      dataUpdate: new Date().toISOString()
    }
  };

  // @ts-expect-error override global fetch for tests
  global.fetch = vi.fn((url: string) => {
    const normalize = (u: string) => {
      if (u.includes('/customers/') && u.includes('/telemetry/now')) return '/customers/:id/telemetry/now';
      if (u.includes('/customers/') && u.includes('/chart')) return '/customers/:id/chart';
      if (u.endsWith('/health')) return '/health';
      if (u.startsWith('https://api.ipma.pt/')) return u;
      return u;
    };

    const key = normalize(url);
    const payload = handlers[key] ?? {};
    return Promise.resolve({ ok: true, json: async () => payload });
  });
};

describe('App', () => {
  it('mostra Login quando não autenticado', async () => {
    mockFetch();

    localStorage.removeItem('kynex:authToken');
    localStorage.removeItem('kynex:customerId');

    render(<App />);

    await waitFor(() => expect(screen.getByText(/bem-vindo\(a\) de volta/i)).toBeInTheDocument());
  });

  it('mostra Dashboard quando autenticado', async () => {
    mockFetch();

    localStorage.setItem('kynex:customerId', 'U_test');
    localStorage.setItem('kynex:authToken', 'test-token');
    localStorage.setItem('kynex:onboarding', JSON.stringify({ name: 'Susana' }));

    render(<App />);

    await waitFor(() => expect(screen.getByText(/consumo \(kWh\)/i)).toBeInTheDocument());
  });
});
