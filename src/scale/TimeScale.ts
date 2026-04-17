/**
 * TimeScale interface — defines how the timeline divides time into columns.
 * Each scale produces column boundaries for a given range.
 */

export interface ColumnBoundary {
  /** Start of this column in fractional years. */
  start: number;
  /** End of this column in fractional years. */
  end: number;
  /** Display label for this column. */
  label: string;
  /** Coarser label for the top tier header (e.g., "2025" above month columns). */
  tierLabel?: string;
  /** Whether this is the first column in a new tier group. */
  isTierStart?: boolean;
}

export interface TimeScale {
  id: string;
  label: string;
  /** Approximate duration of one unit in years. Used for auto-scale selection. */
  unitDurationYears: number;
  /** Whether this scale works at sub-year precision. */
  supportsSubYear: boolean;
  /** Whether this scale supports BCE dates. */
  supportsBCE: boolean;
  /**
   * Optional minimum pixel width per column for canvas sizing. Scales with
   * many narrow columns (hour, day) should set this to a smaller value
   * (e.g. 24-30) to avoid absurdly wide canvases. Defaults to 80.
   */
  minColumnPx?: number;
  /**
   * Optional write precision. When a user drags at this scale, frontmatter
   * writes will be emitted with at least this precision (unless the
   * original value had a coarser precision — see DragManager).
   */
  writePrecision?: 'year' | 'month' | 'day' | 'hour' | 'minute';
  /** Generate column boundaries for the given year range. */
  getColumnBoundaries(start: number, end: number): ColumnBoundary[];
  /** Snap a fractional year to the nearest unit boundary. */
  snapToUnit(year: number): number;
}

/**
 * Registry of all available scales, ordered from finest to coarsest.
 */
export const SCALES: TimeScale[] = [];

export function registerScale(scale: TimeScale): void {
  SCALES.push(scale);
  SCALES.sort((a, b) => a.unitDurationYears - b.unitDurationYears);
}

/**
 * Auto-select the best scale for a given year range and pixel width.
 * Aims for columns between 60px and 200px wide.
 */
export function autoSelectScale(yearRange: number, pixelWidth: number): TimeScale {
  const targetColumnPx = 100;
  const targetColumns = Math.max(1, pixelWidth / targetColumnPx);
  const targetUnitYears = yearRange / targetColumns;

  let best = SCALES[0];
  let bestDist = Infinity;

  for (const scale of SCALES) {
    const dist = Math.abs(Math.log(scale.unitDurationYears) - Math.log(targetUnitYears));
    if (dist < bestDist) {
      bestDist = dist;
      best = scale;
    }
  }
  return best;
}
