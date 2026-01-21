import { getIpmaTempForLocalDateTime, IpmaDailyForecastResponse } from './ipma';

describe('ipma hourly temperature curve', () => {
  const mk = (tMin: string, tMax: string, date: string) => ({ forecastDate: date, tMin, tMax });

  test('hits tMin at ~06:00 and tMax at ~15:00', () => {
    const forecast: IpmaDailyForecastResponse = {
      globalIdLocal: 1131200,
      data: [mk('6', '16', '2026-01-21'), mk('7', '17', '2026-01-22')]
    };

    const t0600 = getIpmaTempForLocalDateTime(forecast, '2026-01-21', 6 * 60);
    const t1500 = getIpmaTempForLocalDateTime(forecast, '2026-01-21', 15 * 60);

    expect(t0600).not.toBeNull();
    expect(t1500).not.toBeNull();
    expect(Number(t0600!.toFixed(2))).toBeCloseTo(6, 2);
    expect(Number(t1500!.toFixed(2))).toBeCloseTo(16, 2);
  });

  test('night cool-down trends toward next-day tMin when available', () => {
    const forecast: IpmaDailyForecastResponse = {
      globalIdLocal: 1131200,
      data: [mk('6', '16', '2026-01-21'), mk('10', '18', '2026-01-22')]
    };

    const t1800 = getIpmaTempForLocalDateTime(forecast, '2026-01-21', 18 * 60);
    const t0500 = getIpmaTempForLocalDateTime(forecast, '2026-01-21', 5 * 60);

    expect(t1800).not.toBeNull();
    expect(t0500).not.toBeNull();

    // 18:00 deve estar abaixo do máximo diário
    expect(t1800!).toBeLessThanOrEqual(16);
    // 05:00 deve estar mais perto do tMin do dia seguinte (10) do que do tMin do próprio dia (6)
    expect(Math.abs(t0500! - 10)).toBeLessThan(Math.abs(t0500! - 6));
  });
});
