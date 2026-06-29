/**
 * Formatters, mirroring public/js/ui.js exactly.
 *
 * Web and mobile must render the same run identically — a distance that reads
 * differently on the two clients looks like a data bug to the user even when
 * the underlying number is the same.
 */

export function area(m2: number): string {
  const v = Number(m2) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)} km²`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(2)} ha`;
  return `${Math.round(v).toLocaleString()} m²`;
}

export function distance(km: number): string {
  const v = Number(km) || 0;
  if (v < 1) return `${Math.round(v * 1000)} m`;
  return `${v.toFixed(2)} km`;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function pace(km: number, seconds: number): string {
  const d = Number(km) || 0;
  const t = Number(seconds) || 0;
  if (d < 0.05 || t <= 0) return '—';
  const secPerKm = t / d;
  if (secPerKm > 3600) return '—';
  let m = Math.floor(secPerKm / 60);
  let s = Math.round(secPerKm % 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${String(s).padStart(2, '0')} /km`;
}

export function number(n: number): string {
  return (Number(n) || 0).toLocaleString();
}

export function ordinal(n: number): string {
  const v = Number(n) || 0;
  const s = ['th', 'st', 'nd', 'rd'];
  const r = v % 100;
  return `${v}${s[(r - 20) % 10] || s[r] || s[0]}`;
}

export function date(value: string | Date | null | undefined): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch { return String(value); }
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return String(value); }
}

export function calories(distanceKm: number, weightKg = 70): number {
  return Math.round(distanceKm * weightKg * 0.63);
}
