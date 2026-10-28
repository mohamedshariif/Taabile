import { describe, expect, it } from 'vitest';
import { applyTheme, parseTheme, readTheme, saveTheme, THEME_KEY } from './theme';

const fakeStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const fakeRoot = () => {
  const attrs = new Map<string, string>();
  return { setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k), attrs };
};

describe('theme choice', () => {
  it('only light and dark are real choices; anything else follows the device', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    for (const x of ['system', '', 'blue', null, undefined, 3]) expect(parseTheme(x)).toBe('system');
  });

  it('is remembered, and "device" forgets the choice', () => {
    const s = fakeStorage();
    expect(readTheme(s)).toBe('system');
    saveTheme('dark', s);
    expect(s.m.get(THEME_KEY)).toBe('dark');
    expect(readTheme(s)).toBe('dark');
    saveTheme('system', s);
    expect(s.m.has(THEME_KEY)).toBe(false);
    expect(readTheme(s)).toBe('system');
  });

  it('never throws when storage is blocked', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(readTheme(blocked)).toBe('system');
    expect(() => saveTheme('dark', blocked)).not.toThrow();
    expect(readTheme(null)).toBe('system');
    expect(() => saveTheme('light', null)).not.toThrow();
  });

  it('sets or clears the data-theme attribute', () => {
    const r = fakeRoot();
    applyTheme('dark', r);
    expect(r.attrs.get('data-theme')).toBe('dark');
    applyTheme('light', r);
    expect(r.attrs.get('data-theme')).toBe('light');
    applyTheme('system', r);
    expect(r.attrs.has('data-theme')).toBe(false);
  });
});