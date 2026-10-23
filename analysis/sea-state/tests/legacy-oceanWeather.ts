// READ-ONLY TEST SNAPSHOT of original console mapping; never production physics.
const GRAVITY = 9.80665;

/** Engine limits (`OceanSpectrum.checkRange`). */
const HS_MAX = 30;
const PERIOD_MIN = 2;
const PERIOD_MAX = 30;
const WIND_MAX = 70;

export function normalizeBearing(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Pierson–Moskowitz fully developed significant wave height, meters. */
export function piersonMoskowitzHeight(windSpeedMps: number): number {
  const u = Math.max(0, windSpeedMps);
  return (0.21 * u * u) / GRAVITY;
}

/** Pierson–Moskowitz peak period, seconds. */
export function piersonMoskowitzPeriod(windSpeedMps: number): number {
  const u = Math.max(0, windSpeedMps);
  return (2 * Math.PI * u) / (0.877 * GRAVITY);
}

/**
 * Map a weather sample onto the engine's sea state. Missing wave fields
 * follow from the wind (Pierson–Moskowitz); everything is clamped to the
 * engine's accepted ranges; a flat calm keeps a meter-scale residual swell
 * so the ocean never freezes into glass.
 */
export function oceanStateFromWeather(sample: OceanWeatherSample): OceanSeaState {
  const wind = Math.min(WIND_MAX, Math.max(0, Number(sample.windSpeedMps) || 0));
  const windFrom = normalizeBearing(Number(sample.windFromDeg) || 0);
  const heightFromWind = piersonMoskowitzHeight(wind);
  const periodFromWind = piersonMoskowitzPeriod(wind);
  const height = Number.isFinite(sample.waveHeightM) && (sample.waveHeightM as number) > 0
    ? (sample.waveHeightM as number)
    : heightFromWind;
  const period = Number.isFinite(sample.wavePeriodS) && (sample.wavePeriodS as number) > 0
    ? (sample.wavePeriodS as number)
    : periodFromWind;
  const waveFrom = Number.isFinite(sample.waveFromDeg)
    ? normalizeBearing(sample.waveFromDeg as number)
    : windFrom;
  return {
    windSpeedMps: wind,
    windFromDeg: windFrom,
    swellHeightM: Math.min(HS_MAX, Math.max(0.4, height)),
    swellPeriodS: Math.min(PERIOD_MAX, Math.max(PERIOD_MIN, period)),
    swellFromDeg: waveFrom,
    // Choppier as the wind picks up: 0.6 in a calm, 1.2 at a fresh gale.
    chop: 0.6 + 0.6 * Math.min(1, wind / 17),
  };
}

