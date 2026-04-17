/**
 * DragManager — Handles drag-to-move, drag-to-resize, and drag-to-create.
 *
 * State machine:
 *   idle → hover → drag-move | drag-resize-start | drag-resize-end | drag-create
 *
 * Ghost bar is shown during drag. On drop, frontmatter is updated via Obsidian API.
 */

import type { App, TFile } from 'obsidian';
import { Notice } from 'obsidian';
import type { SabidurianEntry } from '../model/SabidurianEntry';
import { NumericAxis } from '../scale/NumericAxis';
import { TimeScale } from '../scale/TimeScale';
import {
  sabidurianDateToYear,
  formatSabidurianDate,
  getDatePrecision,
  maxPrecision,
  yearToYAMLString,
  type SabidurianDate,
  type DatePrecision,
} from '../utils/dateUtils';
import { BAR_HEIGHT } from '../model/LayoutEngine';

const SVG_NS = 'http://www.w3.org/2000/svg';
const EDGE_THRESHOLD = 14; // px from edge to trigger resize
const MIN_DRAG_PX = 4;   // minimum move before drag starts
const MIN_BAR_YEARS = 0.002; // ~1 day minimum bar width

type DragState = 'idle' | 'pending' | 'drag-move' | 'drag-resize-start' | 'drag-resize-end' | 'drag-create';

interface DragContext {
  state: DragState;
  entry: SabidurianEntry | null;
  startMouseX: number;
  startMouseY: number;
  originalStartYear: number;
  originalEndYear: number;
  ghostEl: SVGRectElement | null;
  dateLabelEl: HTMLElement | null;
}

export class DragManager {
  private app: App;
  private svg: SVGSVGElement;
  private axis: NumericAxis;
  private scale: TimeScale;
  private wrapperEl: HTMLElement;
  private entries: SabidurianEntry[] = [];
  private getRowY: (row: number) => number = () => 0;

  private ctx: DragContext = {
    state: 'idle',
    entry: null,
    startMouseX: 0,
    startMouseY: 0,
    originalStartYear: 0,
    originalEndYear: 0,
    ghostEl: null,
    dateLabelEl: null,
  };

  // Callbacks
  private onDragComplete: (() => void) | null = null;
  private onCreateEntry: ((startYear: number, endYear: number) => void) | null = null;

  // Undo support
  private lastUndo: { file: TFile; prop: string; oldVal: string | number; newVal: string | number }[] | null = null;

  // Configurable frontmatter property names for date write-back
  private startPropName = 'start-date';
  private endPropName = 'end-date';

  // Sequence mode: when set, drag writes integer order values instead of dates
  private _sequenceMode: {
    orderPropName: string;
    orderEndPropName: string | null;
    allEntries: SabidurianEntry[];
    app: App;
    denseToSparse?: number[]; // dense index (0-based) → original order value
  } | null = null;

  constructor(
    svg: SVGSVGElement,
    wrapperEl: HTMLElement,
    app: App,
    axis: NumericAxis,
    scale: TimeScale,
  ) {
    this.svg = svg;
    this.wrapperEl = wrapperEl;
    this.app = app;
    this.axis = axis;
    this.scale = scale;

    // Create floating date label
    this.ctx.dateLabelEl = wrapperEl.createDiv({ cls: 'sabidurian-drag-date-label' });
    this.ctx.dateLabelEl.style.display = 'none';
  }

  /** Set the frontmatter property names used for date write-back. */
  setDatePropNames(startProp: string, endProp: string): void {
    this.startPropName = startProp;
    this.endPropName = endProp;
  }

  /**
   * Attach drag behavior to rendered bar groups.
   * Call after BarRenderer.render().
   */
  attachToBarGroups(
    entries: SabidurianEntry[],
    getRowY: (row: number) => number,
  ): void {
    this.entries = entries;
    this.getRowY = getRowY;

    const groups = this.svg.querySelectorAll('.sabidurian-bar-group');
    groups.forEach((group, idx) => {
      if (idx >= entries.length) return;
      const entry = entries[idx];

      // Change cursor near edges
      group.addEventListener('mousemove', (e) => {
        if (this.ctx.state !== 'idle') return;
        if (entry.locked) {
          (group as SVGGElement).style.cursor = 'default';
          return;
        }
        const cursor = this.getCursorType(entry, e as MouseEvent);
        (group as SVGGElement).style.cursor = cursor;
      });

      // Mousedown: start potential drag
      group.addEventListener('mousedown', (e) => {
        if (entry.locked) return; // Locked entries cannot be dragged
        if ((e as MouseEvent).button !== 0) return; // left click only
        e.preventDefault();
        e.stopPropagation();
        this.beginPendingDrag(entry, e as MouseEvent);
      });

      // Suppress resize cursor near right edge of ongoing bars
      if (entry.isOngoing) {
        group.addEventListener('mousemove', (e) => {
          if (this.ctx.state !== 'idle') return;
          const rect = (e.currentTarget as Element).getBoundingClientRect();
          const localX = (e as MouseEvent).clientX - rect.left;
          // Only allow grab (move), never col-resize on right edge
          if (localX > entry.width - EDGE_THRESHOLD) {
            (group as SVGGElement).style.cursor = 'grab';
          }
        });
      }
    });

    // Empty area: drag-to-create
    this.svg.addEventListener('mousedown', (e) => {
      if (this.ctx.state !== 'idle') return;
      // Only if click is on SVG background (not on a bar or group header)
      if ((e.target as Element).closest('.sabidurian-bar-group')) return;
      if ((e.target as Element).closest('.sabidurian-group-header')) return;
      if ((e.target as Element).closest('.sabidurian-arrow-handle')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      this.beginCreateDrag(e);
    });

    // Global mouse handlers
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onMouseUp);
  }

  private getCursorType(entry: SabidurianEntry, e: MouseEvent): string {
    if (entry.isPoint) return 'grab';
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const barWidth = entry.width;
    if (localX < EDGE_THRESHOLD) return 'col-resize';
    if (localX > barWidth - EDGE_THRESHOLD && barWidth > EDGE_THRESHOLD * 2) return 'col-resize';
    return 'grab';
  }

  private beginPendingDrag(entry: SabidurianEntry, e: MouseEvent): void {
    const svgRect = this.svg.getBoundingClientRect();
    const localX = e.clientX - svgRect.left;

    // Determine drag type from cursor position relative to bar
    const barLocalX = localX - entry.x;
    let pendingType: DragState = 'drag-move';
    if (!entry.isPoint) {
      if (barLocalX < EDGE_THRESHOLD) pendingType = 'drag-resize-start';
      else if (barLocalX > entry.width - EDGE_THRESHOLD && !entry.isOngoing) pendingType = 'drag-resize-end';
      // Ongoing bars: right edge resize suppressed — end is always "today"
    }

    this.ctx = {
      state: 'pending',
      entry,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      originalStartYear: entry.startYear,
      originalEndYear: entry.endYear,
      ghostEl: null,
      dateLabelEl: this.ctx.dateLabelEl,
    };
    // Store intended type
    (this.ctx as any)._pendingType = pendingType;
  }

  private beginCreateDrag(e: MouseEvent): void {
    const svgRect = this.svg.getBoundingClientRect();
    const localX = e.clientX - svgRect.left;
    const startYear = this.axis.pixelToYear(localX);

    this.ctx = {
      state: 'drag-create',
      entry: null,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      originalStartYear: startYear,
      originalEndYear: startYear,
      ghostEl: null,
      dateLabelEl: this.ctx.dateLabelEl,
    };

    this.createGhost(localX, e.clientY - svgRect.top, 2);
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (this.ctx.state === 'idle') return;

    const dx = e.clientX - this.ctx.startMouseX;

    // Transition from pending to active drag after threshold
    if (this.ctx.state === 'pending') {
      if (Math.abs(dx) < MIN_DRAG_PX) return;
      const type = (this.ctx as any)._pendingType as DragState;
      this.ctx.state = type;
      document.body.classList.add('sabidurian-dragging');

      // Create ghost
      if (this.ctx.entry) {
        const y = this.getRowY(this.ctx.entry.row);
        this.createGhost(this.ctx.entry.x, y, this.ctx.entry.width || 20);
      }
    }

    const svgRect = this.svg.getBoundingClientRect();
    const localX = e.clientX - svgRect.left;
    const currentYear = this.axis.pixelToYear(localX);

    switch (this.ctx.state) {
      case 'drag-move':
        this.handleDragMove(currentYear, dx);
        break;
      case 'drag-resize-start':
        this.handleResizeStart(currentYear);
        break;
      case 'drag-resize-end':
        this.handleResizeEnd(currentYear);
        break;
      case 'drag-create':
        this.handleCreateDrag(currentYear);
        break;
    }

    // Update date label
    this.updateDateLabel(e);
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (this.ctx.state === 'idle' || this.ctx.state === 'pending') {
      this.resetDrag();
      return;
    }

    const state = this.ctx.state;
    const entry = this.ctx.entry;

    if (state === 'drag-create') {
      this.finishCreate();
    } else if (entry && (state === 'drag-move' || state === 'drag-resize-start' || state === 'drag-resize-end')) {
      this.finishEntryDrag(entry);
    }

    // Suppress the click event that follows mouseup after a real drag.
    // Without this, BarRenderer's click-to-open fires and opens the file.
    this.suppressNextClick();

    this.resetDrag();
  };

  /**
   * Eat the very next click event (capture phase) so it never reaches
   * BarRenderer's click-to-open handler.
   */
  private suppressNextClick(): void {
    const handler = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      document.removeEventListener('click', handler, true);
    };
    document.addEventListener('click', handler, true);
    // Safety: remove after a short timeout in case no click fires
    setTimeout(() => document.removeEventListener('click', handler, true), 200);
  }

  private handleDragMove(currentYear: number, dx: number): void {
    const entry = this.ctx.entry!;
    const yearDelta = this.axis.pixelToYear(this.axis.yearToPixel(this.ctx.originalStartYear) + dx) - this.ctx.originalStartYear;
    const duration = this.ctx.originalEndYear - this.ctx.originalStartYear;

    const newStart = this.scale.snapToUnit(this.ctx.originalStartYear + yearDelta);
    const newEnd = newStart + duration;

    // Update ghost position
    if (this.ctx.ghostEl) {
      const x = this.axis.yearToPixel(newStart);
      const w = Math.max(this.axis.yearToPixel(newEnd) - x, 4);
      this.ctx.ghostEl.setAttribute('x', `${x}`);
      this.ctx.ghostEl.setAttribute('width', `${w}`);
    }

    // Store pending new values
    (this.ctx as any)._newStart = newStart;
    (this.ctx as any)._newEnd = newEnd;
  }

  private handleResizeStart(currentYear: number): void {
    const snapped = this.scale.snapToUnit(currentYear);
    const maxStart = this.ctx.originalEndYear - MIN_BAR_YEARS;
    const newStart = Math.min(snapped, maxStart);

    if (this.ctx.ghostEl) {
      const x = this.axis.yearToPixel(newStart);
      const w = Math.max(this.axis.yearToPixel(this.ctx.originalEndYear) - x, 4);
      this.ctx.ghostEl.setAttribute('x', `${x}`);
      this.ctx.ghostEl.setAttribute('width', `${w}`);
    }

    (this.ctx as any)._newStart = newStart;
    (this.ctx as any)._newEnd = this.ctx.originalEndYear;
  }

  private handleResizeEnd(currentYear: number): void {
    const snapped = this.scale.snapToUnit(currentYear);
    const minEnd = this.ctx.originalStartYear + MIN_BAR_YEARS;
    const newEnd = Math.max(snapped, minEnd);

    if (this.ctx.ghostEl) {
      const x = this.axis.yearToPixel(this.ctx.originalStartYear);
      const w = Math.max(this.axis.yearToPixel(newEnd) - x, 4);
      this.ctx.ghostEl.setAttribute('width', `${w}`);
    }

    (this.ctx as any)._newStart = this.ctx.originalStartYear;
    (this.ctx as any)._newEnd = newEnd;
  }

  private handleCreateDrag(currentYear: number): void {
    const snapped = this.scale.snapToUnit(currentYear);
    const start = Math.min(this.ctx.originalStartYear, snapped);
    const end = Math.max(this.ctx.originalStartYear, snapped);

    if (this.ctx.ghostEl) {
      const x = this.axis.yearToPixel(start);
      const w = Math.max(this.axis.yearToPixel(end) - x, 4);
      this.ctx.ghostEl.setAttribute('x', `${x}`);
      this.ctx.ghostEl.setAttribute('width', `${w}`);
    }

    (this.ctx as any)._newStart = start;
    (this.ctx as any)._newEnd = end;
  }

  private async finishEntryDrag(entry: SabidurianEntry): Promise<void> {
    const newStart = (this.ctx as any)._newStart as number;
    const newEnd = (this.ctx as any)._newEnd as number;

    if (Math.abs(newStart - this.ctx.originalStartYear) < 0.0001 &&
        Math.abs(newEnd - this.ctx.originalEndYear) < 0.0001) {
      return; // No change
    }

    // ── Sequence mode: write integer order values ──
    if (this._sequenceMode) {
      const orderProp = this._sequenceMode.orderPropName;
      const orderEndProp = this._sequenceMode.orderEndPropName;
      const d2s = this._sequenceMode.denseToSparse;
      // In sequence mode, endYear is exclusive (position N occupies [N, N+1)),
      // so the inclusive end position is endYear - 1.
      const rawOrder = Math.round(newStart);
      const rawOrderEnd = Math.round(newEnd) - 1;
      // In dense mode, convert dense index back to original order value
      const newOrder = d2s ? (d2s[rawOrder - 1] ?? rawOrder) : rawOrder;
      const newOrderEnd = d2s ? (d2s[rawOrderEnd - 1] ?? rawOrderEnd) : rawOrderEnd;
      const startChanged = Math.abs(newStart - this.ctx.originalStartYear) > 0.5;
      const endChanged = Math.abs(newEnd - this.ctx.originalEndYear) > 0.5;

      await this.app.fileManager.processFrontMatter(entry.file, (fm) => {
        if (startChanged || endChanged) {
          fm[orderProp] = newOrder;
        }
        // Write order-end if: the property is configured AND the entry spans
        // more than one step (i.e. it's not a single-position bar).
        if (orderEndProp && newOrderEnd > newOrder) {
          fm[orderEndProp] = newOrderEnd;
        } else if (orderEndProp && newOrderEnd <= newOrder && fm[orderEndProp] != null) {
          // Entry was resized down to a single step — remove the end property
          delete fm[orderEndProp];
        }
      });

      const label = newOrderEnd > newOrder
        ? `position ${newOrder}–${newOrderEnd}`
        : `position ${newOrder}`;
      new Notice(`Moved "${entry.label}" to ${label}`, 5000);

      this.onDragComplete?.();
      return;
    }

    // ── Timeline mode: write date strings ──
    const startPrecision = this.precisionForEntry(entry, 'start');
    const endPrecision = this.precisionForEntry(entry, 'end');
    const startDateStr = this.yearToDateString(newStart, startPrecision);
    const endDateStr = this.yearToDateString(newEnd, endPrecision);
    const oldStartStr = this.yearToDateString(this.ctx.originalStartYear, startPrecision);
    const oldEndStr = this.yearToDateString(this.ctx.originalEndYear, endPrecision);

    // Write back to frontmatter using configured property names
    await this.app.fileManager.processFrontMatter(entry.file, (fm) => {
      fm[this.startPropName] = startDateStr;
      if (!entry.isPoint && !entry.isOngoing) {
        fm[this.endPropName] = endDateStr;
      }
    });

    // Undo support
    const undoEntries: typeof this.lastUndo & object = [
      { file: entry.file, prop: this.startPropName, oldVal: oldStartStr, newVal: startDateStr },
    ];
    if (!entry.isPoint) {
      undoEntries.push({ file: entry.file, prop: this.endPropName, oldVal: oldEndStr, newVal: endDateStr });
    }
    this.lastUndo = undoEntries;

    // Toast
    const notice = new Notice(
      `Moved "${entry.label}" to ${startDateStr}`,
      8000,
    );

    this.onDragComplete?.();
  }

  private async finishCreate(): Promise<void> {
    const newStart = (this.ctx as any)._newStart as number;
    const newEnd = (this.ctx as any)._newEnd as number;

    if (Math.abs(newEnd - newStart) < MIN_BAR_YEARS) return; // Too small

    this.onCreateEntry?.(newStart, newEnd);
  }

  private createGhost(x: number, y: number, width: number): void {
    this.removeGhost();
    const ghost = document.createElementNS(SVG_NS, 'rect');
    ghost.setAttribute('x', `${x}`);
    ghost.setAttribute('y', `${y}`);
    ghost.setAttribute('width', `${Math.max(width, 4)}`);
    ghost.setAttribute('height', `${BAR_HEIGHT}`);
    ghost.setAttribute('rx', '4');
    ghost.classList.add('sabidurian-ghost-bar');
    this.svg.appendChild(ghost);
    this.ctx.ghostEl = ghost;
  }

  private removeGhost(): void {
    if (this.ctx.ghostEl) {
      this.ctx.ghostEl.remove();
      this.ctx.ghostEl = null;
    }
  }

  private updateDateLabel(e: MouseEvent): void {
    if (!this.ctx.dateLabelEl) return;
    const newStart = (this.ctx as any)._newStart as number | undefined;
    const newEnd = (this.ctx as any)._newEnd as number | undefined;
    if (newStart == null) return;

    let startStr: string;
    let endStr: string;

    if (this._sequenceMode) {
      // Sequence mode: show integer positions (reverse-map dense → original)
      const d2s = this._sequenceMode.denseToSparse;
      const rawS = Math.round(newStart);
      const rawE = newEnd != null ? Math.round(newEnd) : null;
      startStr = String(d2s ? (d2s[rawS - 1] ?? rawS) : rawS);
      endStr = rawE != null ? String(d2s ? (d2s[rawE - 1] ?? rawE) : rawE) : '';
    } else {
      const entry = this.ctx.entry;
      const sp = entry ? this.precisionForEntry(entry, 'start') : this.scaleWritePrecision();
      const ep = entry ? this.precisionForEntry(entry, 'end') : this.scaleWritePrecision();
      startStr = String(this.yearToDateString(newStart, sp));
      endStr = newEnd != null ? String(this.yearToDateString(newEnd, ep)) : '';
    }

    this.ctx.dateLabelEl.setText(endStr ? `${startStr} → ${endStr}` : startStr);
    this.ctx.dateLabelEl.style.display = 'block';
    this.ctx.dateLabelEl.style.left = `${e.clientX + 12}px`;
    this.ctx.dateLabelEl.style.top = `${e.clientY - 30}px`;
  }

  private resetDrag(): void {
    this.removeGhost();
    if (this.ctx.dateLabelEl) {
      this.ctx.dateLabelEl.style.display = 'none';
    }
    this.ctx.state = 'idle';
    this.ctx.entry = null;
    document.body.classList.remove('sabidurian-dragging');
  }

  /**
   * Convert a fractional year back to a YAML-friendly date string at the
   * given precision. Precision defaults to 'day' (legacy behavior).
   */
  private yearToDateString(
    fractionalYear: number,
    precision: DatePrecision = 'day',
  ): string | number {
    return yearToYAMLString(fractionalYear, precision);
  }

  /** Return the scale's native write precision, defaulting to 'day'. */
  private scaleWritePrecision(): DatePrecision {
    return this.scale.writePrecision ?? 'day';
  }

  /**
   * Decide the precision at which to write an entry's start/end date.
   *
   * Uses the finer of:
   *   - the original date's precision (so datetime inputs round-trip as datetime)
   *   - the current scale's write precision (so hour-scale drags can gain minute
   *     precision on date-only entries)
   */
  private precisionForEntry(
    entry: SabidurianEntry,
    which: 'start' | 'end',
  ): DatePrecision {
    const date: SabidurianDate | null | undefined = which === 'start' ? entry.start : entry.end;
    const origPrecision: DatePrecision = date ? getDatePrecision(date) : 'day';
    return maxPrecision(origPrecision, this.scaleWritePrecision());
  }

  /** Set callback for when a drag operation completes (triggers re-render). */
  setDragCompleteCallback(cb: () => void): void {
    this.onDragComplete = cb;
  }

  /** Set callback for drag-to-create. */
  setCreateCallback(cb: (startYear: number, endYear: number) => void): void {
    this.onCreateEntry = cb;
  }

  /**
   * Enable sequence mode: drag write-back writes integer order values
   * instead of date strings. Used by SequenceView.
   */
  setSequenceMode(opts: {
    orderPropName: string;
    orderEndPropName: string | null;
    allEntries: SabidurianEntry[];
    app: App;
    denseToSparse?: number[];
  }): void {
    this._sequenceMode = opts;
  }

  destroy(): void {
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseup', this.onMouseUp);
    this.removeGhost();
    this.ctx.dateLabelEl?.remove();
    this.ctx.dateLabelEl = null;
  }
}
