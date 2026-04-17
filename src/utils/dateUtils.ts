/**
 * Date utilities for Sabidurian Timeline.
 * Handles parsing, formatting, and BCE date logic.
 */

export type DatePrecision = 'year' | 'month' | 'day' | 'hour' | 'minute';

export interface SabidurianDate {
  year: number;           // Negative for BCE: -500 = 501 BCE
  month?: number;         // 0-11, only for CE dates at month+ precision
  day?: number;           // 1-31, only for CE dates at day+ precision
  hour?: number;          // 0-23
  minute?: number;        // 0-59
  isHistorical: boolean;  // true if year < 1 (BCE territory)
}

const PRECISION_ORDER: Record<DatePrecision, number> = {
  year: 0,
  month: 1,
  day: 2,
  hour: 3,
  minute: 4,
};

/** Return the finest precision actually populated on the date. */
export function getDatePrecision(cd: SabidurianDate): DatePrecision {
  if (cd.minute != null) return 'minute';
  if (cd.hour != null) return 'hour';
  if (cd.day != null) return 'day';
  if (cd.month != null) return 'month';
  return 'year';
}

/** Return the finer of two precisions. */
export function maxPrecision(a: DatePrecision, b: DatePrecision): DatePrecision {
  return PRECISION_ORDER[a] >= PRECISION_ORDER[b] ? a : b;
}

/**
 * Parse a frontmatter value into a SabidurianDate.
 *
 * Priority:
 * 1. ISO 8601 "2025-03-27" → { year: 2025, month: 2, day: 27 }
 * 2. "2025-03" → { year: 2025, month: 2 }
 * 3. "2025" → { year: 2025 }
 * 4. "-500" or "501 BCE" → { year: -500, isHistorical: true }
 * 5. Numeric value → treated as year
 */
export function parseSabidurianDate(value: unknown): SabidurianDate | null {
  if (value == null) return null;

  // Handle raw numbers directly (e.g. -500 from YAML frontmatter)
  if (typeof value === 'number') {
    if (!isFinite(value)) return null;
    return { year: Math.round(value), isHistorical: value < 1 };
  }

  // Handle JS Date objects (YAML auto-parses YYYY-MM-DD strings as Dates)
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    // Use UTC methods to avoid timezone shifts
    const y = value.getUTCFullYear();
    const h = value.getUTCHours();
    const min = value.getUTCMinutes();
    const hasTime = h !== 0 || min !== 0 || value.getUTCSeconds() !== 0;
    const result: SabidurianDate = {
      year: y,
      month: value.getUTCMonth(),
      day: value.getUTCDate(),
      isHistorical: y < 1,
    };
    if (hasTime) {
      result.hour = h;
      if (min !== 0) result.minute = min;
    }
    return result;
  }

  const raw = typeof value === 'object' && value !== null && 'toString' in value
    ? value.toString()
    : String(value);

  if (!raw || raw === 'null' || raw === 'undefined') return null;

  // Try BCE string: "501 BCE" or "501 BC"
  const bceMatch = raw.match(/^(\d+)\s*BC(?:E)?$/i);
  if (bceMatch) {
    const bceYear = parseInt(bceMatch[1], 10);
    return { year: -(bceYear - 1), isHistorical: true };
  }

  // Try negative number (astronomical year notation)
  const negMatch = raw.match(/^-(\d+)$/);
  if (negMatch) {
    const y = -parseInt(negMatch[1], 10);
    return { year: y, isHistorical: true };
  }

  // Try ISO 8601 with time: "2025-03-27T14:30:00", "2025-03-27T14:30", "2025-03-27T14"
  // Minutes/seconds optional; trailing TZ info ignored.
  const isoTimeMatch = raw.match(/^(\d{1,4})-(\d{2})-(\d{2})[T ](\d{2})(?::(\d{2}))?(?::(\d{2}))?/);
  if (isoTimeMatch) {
    const y = parseInt(isoTimeMatch[1], 10);
    const result: SabidurianDate = {
      year: y,
      month: parseInt(isoTimeMatch[2], 10) - 1,
      day: parseInt(isoTimeMatch[3], 10),
      hour: parseInt(isoTimeMatch[4], 10),
      isHistorical: false,
    };
    if (isoTimeMatch[5] != null) {
      result.minute = parseInt(isoTimeMatch[5], 10);
    }
    return result;
  }

  // Try ISO date: "2025-03-27" or "0533-03-04" (1-4 digit year)
  const isoDateMatch = raw.match(/^(\d{1,4})-(\d{2})-(\d{2})$/);
  if (isoDateMatch) {
    const y = parseInt(isoDateMatch[1], 10);
    return {
      year: y,
      month: parseInt(isoDateMatch[2], 10) - 1,
      day: parseInt(isoDateMatch[3], 10),
      isHistorical: false,
    };
  }

  // Try year-month: "2025-03" or "0533-03" (1-4 digit year)
  const ymMatch = raw.match(/^(\d{1,4})-(\d{2})$/);
  if (ymMatch) {
    const y = parseInt(ymMatch[1], 10);
    return {
      year: y,
      month: parseInt(ymMatch[2], 10) - 1,
      isHistorical: false,
    };
  }

  // Try plain year: "2025" or "533"
  const yearMatch = raw.match(/^(\d{1,4})$/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    return { year: y, isHistorical: y < 1 };
  }

  return null;
}

/**
 * Convert a SabidurianDate to a JS Date (CE dates only).
 * Returns null for historical/BCE dates.
 */
export function sabidurianDateToDate(cd: SabidurianDate): Date | null {
  if (cd.isHistorical) return null;
  // Use setFullYear to avoid JS treating years 0-99 as 1900-1999
  const d = new Date(2000, cd.month ?? 0, cd.day ?? 1, cd.hour ?? 0, cd.minute ?? 0);
  d.setFullYear(cd.year);
  return d;
}

/**
 * Build a UTC timestamp for the given calendar components, without tripping
 * JavaScript's 0-99 legacy-year bug (Date.UTC(50, ...) returns year 1950).
 */
function ymdToUtcMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): number {
  if (year >= 100) {
    return Date.UTC(year, month, day, hour, minute);
  }
  const d = new Date(Date.UTC(2000, month, day, hour, minute));
  d.setUTCFullYear(year);
  return d.getTime();
}

/**
 * Convert a SabidurianDate to a fractional year for axis positioning.
 * Uses actual-calendar ms math so hour/minute precision round-trips
 * cleanly through yearToYAMLString.
 */
export function sabidurianDateToYear(cd: SabidurianDate): number {
  if (cd.isHistorical || cd.month == null) {
    return cd.year;
  }
  const startMs = ymdToUtcMs(cd.year, 0, 1);
  const endMs = ymdToUtcMs(cd.year + 1, 0, 1);
  const valMs = ymdToUtcMs(
    cd.year,
    cd.month,
    cd.day ?? 1,
    cd.hour ?? 0,
    cd.minute ?? 0,
  );
  return cd.year + (valMs - startMs) / (endMs - startMs);
}

/**
 * Format a year number for display.
 * -500 → "501 BCE"
 *    0 → "1 BCE"
 *    1 → "1 CE"
 * 2025 → "2025"
 */
export function formatYear(year: number): string {
  if (year <= 0) {
    return `${1 - year} BCE`;
  }
  if (year < 100) {
    return `${year} CE`;
  }
  return `${year}`;
}

/**
 * Format a SabidurianDate for display at various precisions.
 */
export function formatSabidurianDate(cd: SabidurianDate): string {
  if (cd.isHistorical) {
    return formatYear(cd.year);
  }
  if (cd.month == null) {
    return `${cd.year}`;
  }
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  if (cd.day == null) {
    return `${monthNames[cd.month]} ${cd.year}`;
  }
  if (cd.hour != null) {
    const hh = String(cd.hour).padStart(2, '0');
    const mm = String(cd.minute ?? 0).padStart(2, '0');
    return `${monthNames[cd.month]} ${cd.day}, ${cd.year} ${hh}:${mm}`;
  }
  return `${monthNames[cd.month]} ${cd.day}, ${cd.year}`;
}

/**
 * Format a SabidurianDate back to YAML-friendly string.
 */
export function formatDateForYAML(cd: SabidurianDate): string | number {
  if (cd.isHistorical) {
    // Return plain number for YAML serialization
    return cd.year;
  }
  const y = String(cd.year).padStart(4, '0');
  if (cd.month == null) return y;
  const m = String(cd.month + 1).padStart(2, '0');
  if (cd.day == null) return `${y}-${m}`;
  const d = String(cd.day).padStart(2, '0');
  if (cd.hour == null) return `${y}-${m}-${d}`;
  const hh = String(cd.hour).padStart(2, '0');
  const mm = String(cd.minute ?? 0).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

/**
 * Convert a fractional year back to a YAML-friendly string at the given precision.
 * BCE years (< 1) always return plain numbers.
 *
 *  - 'year'   → "2026"
 *  - 'month'  → "2026-04"
 *  - 'day'    → "2026-04-17"
 *  - 'hour'   → "2026-04-17T14:00"
 *  - 'minute' → "2026-04-17T14:30"
 *
 * Inverse of sabidurianDateToYear: uses actual-calendar ms math so values
 * round-trip cleanly at minute-level precision.
 */
export function yearToYAMLString(
  fractionalYear: number,
  precision: DatePrecision = 'day',
): string | number {
  if (fractionalYear < 1) {
    return Math.round(fractionalYear);
  }
  const year = Math.floor(fractionalYear);
  const frac = fractionalYear - year;
  if (precision === 'year') return String(year).padStart(4, '0');

  const startMs = ymdToUtcMs(year, 0, 1);
  const endMs = ymdToUtcMs(year + 1, 0, 1);
  let targetMs = startMs + frac * (endMs - startMs);

  if (precision === 'hour') {
    const HOUR_MS = 60 * 60 * 1000;
    targetMs = Math.round(targetMs / HOUR_MS) * HOUR_MS;
  } else if (precision === 'minute') {
    const QH_MS = 15 * 60 * 1000;
    targetMs = Math.round(targetMs / QH_MS) * QH_MS;
  } else if (precision === 'day') {
    const DAY_MS = 24 * 60 * 60 * 1000;
    targetMs = Math.round(targetMs / DAY_MS) * DAY_MS;
  }

  const d = new Date(targetMs);
  const yr = d.getUTCFullYear();
  const yStr = String(yr).padStart(4, '0');
  const mStr = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (precision === 'month') return `${yStr}-${mStr}`;
  const dStr = String(d.getUTCDate()).padStart(2, '0');
  if (precision === 'day') return `${yStr}-${mStr}-${dStr}`;
  const hStr = String(d.getUTCHours()).padStart(2, '0');
  const minStr = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yStr}-${mStr}-${dStr}T${hStr}:${minStr}`;
}

/**
 * Get the number of days in a given month (1-indexed month).
 */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}
