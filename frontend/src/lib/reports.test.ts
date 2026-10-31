import { describe, expect, it } from 'vitest';
import { addDays, agrees, barPercent, localToday, presetRange, rangeProblem, shortDay, toCsv } from './reports';

describe('report helpers', () => {
  it('works out the quick date ranges', () => {
    expect(localToday(new Date(2026, 9, 24))).toBe('2026-10-24');
    expect(presetRange('today', '2026-10-24')).toEqual({ from: '2026-10-24', to: '2026-10-24' });
    expect(presetRange('week', '2026-10-24')).toEqual({ from: '2026-10-18', to: '2026-10-24' });
    expect(presetRange('thirty', '2026-10-24')).toEqual({ from: '2026-09-25', to: '2026-10-24' });
    expect(presetRange('month', '2026-10-24')).toEqual({ from: '2026-10-01', to: '2026-10-24' });
    expect(presetRange('lastMonth', '2026-10-24')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetRange('lastMonth', '2026-01-05')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('spots a range the server would refuse', () => {
    expect(rangeProblem('2026-10-01', '2026-10-31')).toBeUndefined();
    expect(rangeProblem('2026-10-31', '2026-10-01')).toBeTruthy();
    expect(rangeProblem('', '2026-10-01')).toBeTruthy();
    expect(rangeProblem('2025-01-01', '2026-10-01')).toBeTruthy();
  });

  it('draws bars: the biggest is full, a small one is still visible, zero is empty', () => {
    expect(barPercent('50', '100')).toBe(50);
    expect(barPercent('100', '100')).toBe(100);
    expect(barPercent('0.1', '1000')).toBe(2);
    expect(barPercent('0', '100')).toBe(0);
    expect(barPercent('5', '0')).toBe(0);
    expect(shortDay('2026-10-04')).toBe('4 Oct');
  });

  it('books agree within a cent', () => {
    expect(agrees(null)).toBe(true);
    expect(agrees('0.0000')).toBe(true);
    expect(agrees('-0.0040')).toBe(true);
    expect(agrees('0.0500')).toBe(false);
  });

  it('writes a safe CSV', () => {
    expect(toCsv(['Name', 'Total'], [['Sugar, white', '12.50'], ['He said "hi"', 3], [null, '-4.00']])).toBe('Name,Total\r\n"Sugar, white",12.50\r\n"He said ""hi""",3\r\n,-4.00');
    expect(toCsv(['x'], [['=SUM(A1)'], ['@cmd'], ['-cmd'], ['+1']])).toBe("x\r\n'=SUM(A1)\r\n'@cmd\r\n'-cmd\r\n'+1");
  });
});