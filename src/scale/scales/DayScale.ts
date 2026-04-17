import { TimeScale, ColumnBoundary, registerScale } from '../TimeScale';

const HOUR_IN_YEARS = 1 / 8760;
const MINUTE_IN_MS = 60 * 1000;

/**
 * Choose column step (in minutes) based on data range. Preserves 15-minute
 * granularity when zoomed in and coarsens automatically at wider ranges.
 */
function pickStepMinutes(rangeYears: number): number {
  const rangeHours = rangeYears * 8760;
  if (rangeHours <= 12) return 15;       // ≤ 12h: 4 cols/hour
  if (rangeHours <= 48) return 30;       // ≤ 2 days: 2 cols/hour
  if (rangeHours <= 7 * 24) return 60;   // ≤ 1 week: 1 col/hour
  return 180;                             // wider: 3-hour cols
}

export const DayScale: TimeScale = {
  id: 'day',
  label: 'Day',
  unitDurationYears: HOUR_IN_YEARS,
  supportsSubYear: true,
  supportsBCE: false,
  minColumnPx: 26,
  writePrecision: 'minute',

  getColumnBoundaries(start: number, end: number): ColumnBoundary[] {
    const cols: ColumnBoundary[] = [];
    const stepMin = pickStepMinutes(Math.max(end - start, 0.00001));
    const stepMs = stepMin * MINUTE_IN_MS;

    const startDate = fractionalYearToDate(start);
    startDate.setSeconds(0, 0);
    startDate.setMinutes(Math.floor(startDate.getMinutes() / stepMin) * stepMin);
    const endDate = fractionalYearToDate(end);

    let cur = new Date(startDate);
    while (cur <= endDate && cols.length < 10000) {
      const next = new Date(cur.getTime() + stepMs);

      const colStart = dateToFractionalYear(cur);
      const colEnd = dateToFractionalYear(next);

      const h = cur.getHours();
      const m = cur.getMinutes();
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      const label = stepMin >= 60 ? `${hh}:00` : `:${mm}`;
      const dayLabel = cur.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      let tierLabel: string;
      let isTierStart: boolean;
      if (stepMin >= 60) {
        tierLabel = dayLabel;
        isTierStart = h === 0;
      } else {
        const isMidnight = h === 0 && m === 0;
        tierLabel = isMidnight ? `${dayLabel} · ${hh}:00` : `${hh}:00`;
        isTierStart = m === 0;
      }

      cols.push({ start: colStart, end: colEnd, label, tierLabel, isTierStart });
      cur = next;
    }
    return cols;
  },

  snapToUnit(year: number): number {
    const d = fractionalYearToDate(year);
    d.setSeconds(0, 0);
    d.setMinutes(Math.round(d.getMinutes() / 15) * 15);
    return dateToFractionalYear(d);
  },
};

function fractionalYearToDate(fy: number): Date {
  const year = Math.floor(fy);
  const frac = fy - year;
  const start = new Date(year, 0, 1).getTime();
  const end = new Date(year + 1, 0, 1).getTime();
  return new Date(start + frac * (end - start));
}

function dateToFractionalYear(d: Date): number {
  const year = d.getFullYear();
  const start = new Date(year, 0, 1).getTime();
  const end = new Date(year + 1, 0, 1).getTime();
  return year + (d.getTime() - start) / (end - start);
}

registerScale(DayScale);
