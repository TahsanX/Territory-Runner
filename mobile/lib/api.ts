import Constants from 'expo-constants';
import { accessToken } from './supabase';

/**
 * Client for the same Express API the web app uses.
 *
 * Auth travels in the `Authorization: Bearer` header. That path was
 * deliberately kept alive in Phase 1 (middleware/authMiddleware.js) precisely
 * because mobile cannot use the httpOnly cookie the browser relies on.
 */

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;
export const API_URL = (extra.apiUrl || '').replace(/\/$/, '');
export const MAPTILER_KEY = extra.maptilerKey || '';

export class ApiError extends Error {
  status: number;
  offline: boolean;
  constructor(message: string, status = 0, offline = false) {
    super(message);
    this.status = status;
    this.offline = offline;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const token = await accessToken();

  const controller = new AbortController();
  // A phone on a weak connection can hang indefinitely otherwise, which during
  // a run means a flush that never resolves and a buffer that never drains.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);

  if (opts.signal) {
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: any) {
    // Offline and timed-out are reported as the same recoverable condition:
    // the caller should keep the data queued and retry, not discard it.
    throw new ApiError(
      err?.name === 'AbortError' ? 'Request timed out' : 'No connection',
      0,
      true
    );
  } finally {
    clearTimeout(timer);
  }

  let data: any = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) {
    throw new ApiError(data?.message || `Request failed (${res.status})`, res.status, false);
  }

  return data as T;
}

function qs(params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export const tzOffset = () => new Date().getTimezoneOffset();

/** The runner's local date, which is what streaks are computed against. */
export function localDate(): string {
  return new Date(Date.now() - tzOffset() * 60_000).toISOString().slice(0, 10);
}

// --- Types -----------------------------------------------------------------

export type Profile = {
  user: { id: string; username: string; email?: string; avatarUrl?: string; weightKg: number };
  stats: {
    totalDistance: number; totalTime: number; totalCalories: number;
    totalTerritoryArea: number; totalRunningSessions: number;
  };
  ranks: {
    area: { rank: number; total: number; value: number } | null;
    distance: { rank: number; total: number; value: number } | null;
  };
};

export type Territory = {
  id: number;
  isOwn: boolean;
  username?: string;
  area: number;
  labelLat: number | null;
  labelLon: number | null;
  createdAt: string;
  geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon | null;
};

export type FinishResult = {
  stats: { distance: number; calories: number; time: number };
  isClosedLoop: boolean;
  territoryCreated: boolean;
  territoryId: number | null;
  territoryArea: number;
  areaStolen: number;
  territoriesAffected: number;
};

export type CalendarDay = {
  date: string; day: number; weekday: number; runs: number;
  distanceKm: number; calories: number;
  areaGainedM2: number; areaLostM2: number;
  intensity: number; isToday: boolean; isFuture: boolean;
};

// --- Endpoints -------------------------------------------------------------

export const api = {
  profile: () => request<Profile>('GET', '/api/auth/profile'),

  startRun: () =>
    request<{ sessionId: number; startTime: string }>(
      'POST', '/api/run/start', { tzOffsetMinutes: tzOffset() }
    ),

  /** Batched upload. Idempotent server-side via the (session, seq) constraint. */
  uploadCoordinates: (sessionId: number, points: Array<{
    seq: number; latitude: number; longitude: number;
    accuracy: number | null; isPauseMarker: boolean; recordedAt: string;
  }>) =>
    request<{ received: number; inserted: number }>(
      'POST', `/api/run/${sessionId}/coordinates`, { points }, { timeoutMs: 25000 }
    ),

  pauseRun: (sessionId: number, marker?: { seq: number; latitude: number; longitude: number }) =>
    request<{ paused: boolean }>('POST', `/api/run/${sessionId}/pause`, marker ?? {}),

  finishRun: (sessionId: number) =>
    request<FinishResult>('POST', `/api/run/${sessionId}/finish`, { points: [] }, { timeoutMs: 30000 }),

  runState: (sessionId: number) =>
    request<{ sessionId: number; finished: boolean; maxSeq: number }>(
      'GET', `/api/run/${sessionId}/state`
    ),

  history: (limit = 20) =>
    request<{ sessions: any[] }>('GET', `/api/run/history/all${qs({ limit })}`),

  territoriesInBounds: (b: {
    minLat: number; maxLat: number; minLon: number; maxLon: number; zoom: number;
  }) =>
    request<{ territories: Territory[] }>('GET', `/api/territory/bounds${qs(b)}`),

  myTerritories: () =>
    request<{ territories: Territory[]; totalArea: number }>(
      'GET', '/api/territory/user/territories'
    ),

  leaderboard: (metric: 'area' | 'distance', limit = 25) =>
    request<{ leaderboard: any[] }>('GET', `/api/leaderboard/${metric}${qs({ limit })}`),

  calendar: (year: number, month: number) =>
    request<{
      year: number; month: number; days: CalendarDay[];
      streak: { current: number; longest: number; longestThisMonth: number };
      thresholds: { q1: number; q2: number; q3: number; bootstrapped: boolean };
    }>('GET', `/api/stats/calendar${qs({ year, month, tzOffset: tzOffset() })}`),

  summary: (period: 'month' | 'year', year: number, month: number) =>
    request<any>('GET', `/api/stats/summary${qs({ period, year, month, tzOffset: tzOffset() })}`),

  health: () => request<{ status: string; database: string }>('GET', '/api/health'),
};
