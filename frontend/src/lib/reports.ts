// Pure helpers for the report screens (no React, no network). The server does all the real adding up.

const pad = (n: number) => String(n).padStart(2, '0');
/** Today on this device, as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export type Preset = 'today' | 'week' | 'month' | 'lastMonth' | 'thirty';
export const PRESET_LABEL: Record<Preset, string> = { today: 'Today', week: 'Last 7 days', month: 'This month', lastMonth: 'Last month', thirty: 'Last 30 days' };

export function presetRange(p: Preset, today: string): { from: string; to: string } {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (p) {
    case 'today': return { from: today, to: today };
    case 'week': return { from: addDays(today, -6), to: today };
    case 'thirty': return { from: addDays(today, -29), to: today };
    case 'month': return { from: monthStart, to: today };
    case 'lastMonth': return { from: `${addDays(monthStart, -1).slice(0, 7)}-01`, to: addDays(monthStart, -1) };
  }
}

/** Why a chosen range cannot be asked for (the server checks the same). */
export function rangeProblem(from: string, to: string): string | undefined {
  if (!from || !to) return 'Choose both dates';
  if (from > to) return 'The end date cannot be before the start date';
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1 > 366) return 'Choose at most 366 days at a time';
  return undefined;
}

/** 2026-10-24 → "24 Oct". */
export function shortDay(d: string): string {
  const [, m, day] = d.split('-');
  return `${Number(day)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] ?? ''}`;
}

/** How tall a bar is, 0 to 100, against the biggest value. A non-zero value is always visible. */
export function barPercent(value: string, max: string): number {
  const v = Number(value);
  const m = Number(max);
  if (!(v > 0) || !(m > 0)) return 0;
  return Math.max(2, Math.min(100, Math.round((v / m) * 100)));
}

/** The ledger and the documents agree when they are within a cent. */
export const agrees = (difference: string | null): boolean => difference === null || Math.abs(Number(difference)) < 0.01;

/** A CSV file's text. Cells that a spreadsheet could read as a formula are made safe. */
export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null): string => {
    let s = v === null ? '' : String(v);
    if (typeof v === 'string' && /^[=+@\t\r]|^-(?!\d|\.\d)/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

/** Sends a CSV to the person's downloads. A leading mark makes Excel read accents correctly. */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const OWED_BUCKETS = [
  ['notDue', 'Not due yet'],
  ['days1to30', '1–30 days late'],
  ['days31to60', '31–60 days late'],
  ['days61to90', '61–90 days late'],
  ['over90', 'Over 90 days late'],
] as const;