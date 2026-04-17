/**
 * TouchManager — Translates touch gestures into timeline interactions.
 *
 * Gestures:
 *   - Tap → select bar (single selection)
 *   - Double-tap → open note
 *   - Long-press (500ms) on bar → context menu
 *   - Long-press on empty area → drag-to-create
 *   - Touch-drag after long-press → drag-move/resize
 *   - Two-finger pinch → zoom scale
 *
 * Coordinates with DragManager and ContextMenuManager via callbacks rather
 * than re-implementing drag/frontmatter logic.
 */

import type { App, TFile } from 'obsidian';
import type { SabidurianEntry } from '../model/SabidurianEntry';
import { NumericAxis } from '../scale/NumericAxis';
import { TimeScale } from '../scale/TimeScale';
import { BAR_HEIGHT } from '../model/LayoutEngine';
import {
  getDatePrecision,
  maxPrecision,
  yearToYAMLString,
  type DatePrecision,
  type SabidurianDate,
} from '../utils/dateUtils';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 300;
const TAP_MOVE_THRESHOLD = 10; // px — movement beyond this cancels a tap
const EDGE_THRESHOLD = 20;     // wider than desktop (14px) for fat fingers
const MIN_BAR_YEARS = 0.002;

type TouchState =
  | 'idle'
  | 'tap-pending'    // finger down, waiting to see if it's a tap or long-press
  | 'long-press'     // long-press recognised, waiting for menu or drag start
  | 'dragging'       // actively dragging a bar (move or resize)
  | 'creating'       // drag-to-create on empty area
  | 'scrolling';     // normal scroll/pan — don't intercept

interface TouchContext {
  state: TouchState;
  entry: SabidurianEntry | null;
  touchId: number;             // identifier of the tracked touch
  startX: number;
  startY: number;
  startTime: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  originalStartYear: number;
  originalEndYear: number;
  dragType: 'move' | 'resize-start' | 'resize-end';
  ghostEl: SVGRectElement | null;
  dateLabelEl: HTMLElement | null;
}

// Callbacks
type SelectCallback = (entry: SabidurianEntry) => void;
type OpenCallback = (entry: SabidurianEntry) => void;
type ContextMenuCallback = (entry: SabidurianEntry, x: number, y: number) => void;
type EmptyContextMenuCallback = (x: number, y: number) => void;
type DragCompleteCallback = (entry: SabidurianEntry, newStart: number, newEnd: number) => void;
type CreateCallback = (startYear: number, endYear: number) => void;
type ScaleChangeCallback = (direction: 'in' | 'out') => void;

export class TouchManager {
  private app: App;
  private svg: SVGSVGElement;
  private wrapperEl: HTMLElement;
  private axis: NumericAxis;
  private scale: TimeScale;
  private entries: SabidurianEntry[] = [];
  private getRowY: (row: number) => number = () => 0;

  private ctx: TouchContext;
  private lastTapTime = 0;
  private lastTapEntry: SabidurianEntry | null = null;

  // Pinch state
  private pinchStartDist = 0;

  // Callbacks
  private onSelect: SelectCallback | null = null;
  private onOpen: OpenCallback | null = null;
  private onContextMenu: ContextMenuCallback | null = null;
  private onEmptyContextMenu: EmptyContextMenuCallback | null = null;
  private onDragComplete: DragCompleteCallback | null = null;
  private onCreate: CreateCallback | null = null;
  private onScaleChange: ScaleChangeCallback | null = null;

  /** When true, drag-move, resize, and drag-to-create are suppressed. */
  locked = false;

  // Bound handlers for cleanup
  private boundTouchStart: (e: TouchEvent) => void;
  private boundTouchMove: (e: TouchEvent) => void;
  private boundTouchEnd: (e: TouchEvent) => void;
  private boundTouchCancel: (e: TouchEvent) => void;

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

    this.ctx = this.freshContext();

    // Create floating date label (shared with DragManager pattern)
    this.ctx.dateLabelEl = wrapperEl.createDiv({ cls: 'sabidurian-drag-date-label sabidurian-touch-date-label' });
    this.ctx.dateLabelEl.style.display = 'none';

    this.boundTouchStart = this.onTouchStart.bind(this);
    this.boundTouchMove = this.onTouchMove.bind(this);
    this.boundTouchEnd = this.onTouchEnd.bind(this);
    this.boundTouchCancel = this.onTouchCancel.bind(this);
  }

  attach(
    entries: SabidurianEntry[],
    getRowY: (row: number) => number,
  ): void {
    this.entries = entries;
    this.getRowY = getRowY;

    this.svg.addEventListener('touchstart', this.boundTouchStart, { passive: false });
    this.svg.addEventListener('touchmove', this.boundTouchMove, { passive: false });
    this.svg.addEventListener('touchend', this.boundTouchEnd, { passive: false });
    this.svg.addEventListener('touchcancel', this.boundTouchCancel, { passive: false });
  }

  // ── Touch start ──

  private onTouchStart(e: TouchEvent): void {
    // Two-finger pinch
    if (e.touches.length === 2) {
      this.cancelLongPress();
      this.ctx.state = 'scrolling';
      this.pinchStartDist = this.getTouchDistance(e.touches[0], e.touches[1]);
      return;
    }

    if (e.touches.length !== 1) return;
    if (this.ctx.state !== 'idle') return;

    const touch = e.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    const barGroup = target?.closest('.sabidurian-bar-group') as SVGGElement | null;
    const isGroupHeader = target?.closest('.sabidurian-group-header');
    const isArrowHandle = target?.closest('.sabidurian-arrow-handle');

    // Don't intercept group headers or arrow handles
    if (isGroupHeader || isArrowHandle) return;

    const entry = barGroup ? this.findEntryForGroup(barGroup) : null;

    const svgRect = this.svg.getBoundingClientRect();

    this.ctx = {
      ...this.freshContext(),
      state: 'tap-pending',
      entry,
      touchId: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
      dateLabelEl: this.ctx.dateLabelEl,
      originalStartYear: entry?.startYear ?? this.axis.pixelToYear(touch.clientX - svgRect.left),
      originalEndYear: entry?.endYear ?? this.axis.pixelToYear(touch.clientX - svgRect.left),
      dragType: entry ? this.getDragType(entry, touch.clientX - svgRect.left) : 'move',
    };

    // Start long-press timer
    this.ctx.longPressTimer = setTimeout(() => {
      this.onLongPress();
    }, LONG_PRESS_MS);
  }

  // ── Touch move ──

  private onTouchMove(e: TouchEvent): void {
    // Pinch zoom
    if (e.touches.length === 2 && this.pinchStartDist > 0) {
      const dist = this.getTouchDistance(e.touches[0], e.touches[1]);
      const ratio = dist / this.pinchStartDist;
      if (ratio > 1.3) {
        this.onScaleChange?.('in');
        this.pinchStartDist = dist; // Reset for continuous zoom
      } else if (ratio < 0.7) {
        this.onScaleChange?.('out');
        this.pinchStartDist = dist;
      }
      return;
    }

    const touch = this.getTrackedTouch(e);
    if (!touch) return;

    const dx = touch.clientX - this.ctx.startX;
    const dy = touch.clientY - this.ctx.startY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    switch (this.ctx.state) {
      case 'tap-pending':
        // If finger moves too far, cancel tap/long-press and let native scroll handle it
        if (dist > TAP_MOVE_THRESHOLD) {
          this.cancelLongPress();
          this.ctx.state = 'scrolling';
        }
        break;

      case 'long-press':
        // After long-press recognised, any movement starts a drag (unless locked)
        if (dist > TAP_MOVE_THRESHOLD) {
          if (this.locked || this.ctx.entry?.locked) {
            // Locked (view-level or per-note): treat as scroll instead of drag
            this.ctx.state = 'scrolling';
            break;
          }
          e.preventDefault(); // prevent scroll during drag
          if (this.ctx.entry) {
            this.startDrag();
          } else {
            this.startCreate();
          }
        }
        break;

      case 'dragging':
        e.preventDefault();
        this.updateDrag(touch);
        break;

      case 'creating':
        e.preventDefault();
        this.updateCreate(touch);
        break;

      case 'scrolling':
        // Let the browser handle native scrolling
        break;
    }
  }

  // ── Touch end ──

  private onTouchEnd(e: TouchEvent): void {
    // Pinch end
    if (this.pinchStartDist > 0 && e.touches.length < 2) {
      this.pinchStartDist = 0;
      this.reset();
      return;
    }

    const touch = this.getChangedTrackedTouch(e);
    if (!touch) return;

    switch (this.ctx.state) {
      case 'tap-pending':
        this.cancelLongPress();
        this.handleTap();
        break;

      case 'long-press':
        // Long-press without drag → show context menu
        this.cancelLongPress();
        if (this.ctx.entry) {
          this.onContextMenu?.(this.ctx.entry, this.ctx.startX, this.ctx.startY);
        } else {
          this.onEmptyContextMenu?.(this.ctx.startX, this.ctx.startY);
        }
        this.reset();
        break;

      case 'dragging':
        this.finishDrag();
        break;

      case 'creating':
        this.finishCreate();
        break;

      default:
        this.reset();
    }
  }

  private onTouchCancel(_e: TouchEvent): void {
    this.cancelLongPress();
    this.removeGhost();
    this.reset();
  }

  // ── Tap handling (single-tap = select, double-tap = open) ──

  private handleTap(): void {
    const now = Date.now();
    const entry = this.ctx.entry;

    if (
      entry &&
      this.lastTapEntry === entry &&
      now - this.lastTapTime < DOUBLE_TAP_MS
    ) {
      // Double tap → open
      this.onOpen?.(entry);
      this.lastTapTime = 0;
      this.lastTapEntry = null;
    } else if (entry) {
      // Single tap → select
      this.onSelect?.(entry);
      this.lastTapTime = now;
      this.lastTapEntry = entry;
    } else {
      // Tap on empty → deselect
      this.onSelect?.(null as any);
      this.lastTapTime = 0;
      this.lastTapEntry = null;
    }

    this.reset();
  }

  // ── Long press ──

  private onLongPress(): void {
    this.ctx.longPressTimer = null;
    this.ctx.state = 'long-press';

    // Haptic feedback if available
    if ('vibrate' in navigator) {
      navigator.vibrate(30);
    }

    // Visual feedback: highlight the bar
    if (this.ctx.entry) {
      const groups = this.svg.querySelectorAll('.sabidurian-bar-group');
      for (const g of groups) {
        if ((g as SVGGElement).dataset.filePath === this.ctx.entry.file.path) {
          g.classList.add('sabidurian-bar-selected');
          break;
        }
      }
    }
  }

  // ── Drag operations ──

  private startDrag(): void {
    this.ctx.state = 'dragging';
    const entry = this.ctx.entry!;
    const y = this.getRowY(entry.row);
    this.createGhost(entry.x, y, entry.width || 20);
    document.body.classList.add('sabidurian-dragging');
  }

  private updateDrag(touch: Touch): void {
    const entry = this.ctx.entry!;
    const svgRect = this.svg.getBoundingClientRect();
    const localX = touch.clientX - svgRect.left;
    const currentYear = this.axis.pixelToYear(localX);

    let newStart: number;
    let newEnd: number;

    switch (this.ctx.dragType) {
      case 'move': {
        const dx = touch.clientX - this.ctx.startX;
        const yearDelta = this.axis.pixelToYear(
          this.axis.yearToPixel(this.ctx.originalStartYear) + dx,
        ) - this.ctx.originalStartYear;
        const duration = this.ctx.originalEndYear - this.ctx.originalStartYear;
        newStart = this.scale.snapToUnit(this.ctx.originalStartYear + yearDelta);
        newEnd = newStart + duration;
        break;
      }
      case 'resize-start': {
        const snapped = this.scale.snapToUnit(currentYear);
        newStart = Math.min(snapped, this.ctx.originalEndYear - MIN_BAR_YEARS);
        newEnd = this.ctx.originalEndYear;
        break;
      }
      case 'resize-end': {
        const snapped = this.scale.snapToUnit(currentYear);
        newStart = this.ctx.originalStartYear;
        newEnd = Math.max(snapped, this.ctx.originalStartYear + MIN_BAR_YEARS);
        break;
      }
    }

    // Update ghost
    if (this.ctx.ghostEl) {
      const x = this.axis.yearToPixel(newStart);
      const w = Math.max(this.axis.yearToPixel(newEnd) - x, 4);
      this.ctx.ghostEl.setAttribute('x', `${x}`);
      this.ctx.ghostEl.setAttribute('width', `${w}`);
    }

    // Store pending values
    (this.ctx as any)._newStart = newStart;
    (this.ctx as any)._newEnd = newEnd;

    // Update date label
    this.updateDateLabel(touch);
  }

  private finishDrag(): void {
    const entry = this.ctx.entry!;
    const newStart = (this.ctx as any)._newStart as number | undefined;
    const newEnd = (this.ctx as any)._newEnd as number | undefined;

    if (newStart != null && newEnd != null) {
      if (
        Math.abs(newStart - this.ctx.originalStartYear) > 0.0001 ||
        Math.abs(newEnd - this.ctx.originalEndYear) > 0.0001
      ) {
        this.onDragComplete?.(entry, newStart, newEnd);
      }
    }

    this.removeGhost();
    this.reset();
  }

  // ── Create operations ──

  private startCreate(): void {
    this.ctx.state = 'creating';
    const svgRect = this.svg.getBoundingClientRect();
    const localX = this.ctx.startX - svgRect.left;
    const localY = this.ctx.startY - svgRect.top;
    this.createGhost(localX, localY, 2);
    document.body.classList.add('sabidurian-dragging');
  }

  private updateCreate(touch: Touch): void {
    const svgRect = this.svg.getBoundingClientRect();
    const localX = touch.clientX - svgRect.left;
    const currentYear = this.axis.pixelToYear(localX);
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

    this.updateDateLabel(touch);
  }

  private finishCreate(): void {
    const newStart = (this.ctx as any)._newStart as number | undefined;
    const newEnd = (this.ctx as any)._newEnd as number | undefined;

    if (newStart != null && newEnd != null && Math.abs(newEnd - newStart) > MIN_BAR_YEARS) {
      this.onCreate?.(newStart, newEnd);
    }

    this.removeGhost();
    this.reset();
  }

  // ── Ghost bar ──

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

  // ── Helpers ──

  private getDragType(entry: SabidurianEntry, svgLocalX: number): 'move' | 'resize-start' | 'resize-end' {
    if (entry.isPoint) return 'move';
    const barLocalX = svgLocalX - entry.x;
    if (barLocalX < EDGE_THRESHOLD) return 'resize-start';
    if (barLocalX > entry.width - EDGE_THRESHOLD) return 'resize-end';
    return 'move';
  }

  private findEntryForGroup(group: SVGGElement): SabidurianEntry | null {
    const filePath = group.dataset.filePath;
    if (!filePath) return null;
    return this.entries.find(e => e.file.path === filePath) ?? null;
  }

  private getTrackedTouch(e: TouchEvent): Touch | null {
    for (let i = 0; i < e.touches.length; i++) {
      if (e.touches[i].identifier === this.ctx.touchId) return e.touches[i];
    }
    return null;
  }

  private getChangedTrackedTouch(e: TouchEvent): Touch | null {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === this.ctx.touchId) return e.changedTouches[i];
    }
    return null;
  }

  private getTouchDistance(a: Touch, b: Touch): number {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private cancelLongPress(): void {
    if (this.ctx.longPressTimer) {
      clearTimeout(this.ctx.longPressTimer);
      this.ctx.longPressTimer = null;
    }
  }

  private updateDateLabel(touch: Touch): void {
    if (!this.ctx.dateLabelEl) return;
    const newStart = (this.ctx as any)._newStart as number | undefined;
    const newEnd = (this.ctx as any)._newEnd as number | undefined;
    if (newStart == null) return;

    const entry = this.ctx.entry;
    const sp = entry ? this.precisionForEntry(entry, 'start') : this.scaleWritePrecision();
    const ep = entry ? this.precisionForEntry(entry, 'end') : this.scaleWritePrecision();
    const startStr = this.yearToDateString(newStart, sp);
    const endStr = newEnd != null ? this.yearToDateString(newEnd, ep) : '';
    this.ctx.dateLabelEl.setText(endStr ? `${startStr} → ${endStr}` : startStr);
    this.ctx.dateLabelEl.style.display = 'block';
    // Position above the finger
    this.ctx.dateLabelEl.style.left = `${touch.clientX - 40}px`;
    this.ctx.dateLabelEl.style.top = `${touch.clientY - 50}px`;
  }

  private yearToDateString(
    fractionalYear: number,
    precision: DatePrecision = 'day',
  ): string {
    return String(yearToYAMLString(fractionalYear, precision));
  }

  private scaleWritePrecision(): DatePrecision {
    return this.scale.writePrecision ?? 'day';
  }

  private precisionForEntry(
    entry: SabidurianEntry,
    which: 'start' | 'end',
  ): DatePrecision {
    const date: SabidurianDate | null | undefined = which === 'start' ? entry.start : entry.end;
    const origPrecision: DatePrecision = date ? getDatePrecision(date) : 'day';
    return maxPrecision(origPrecision, this.scaleWritePrecision());
  }

  private freshContext(): TouchContext {
    return {
      state: 'idle',
      entry: null,
      touchId: -1,
      startX: 0,
      startY: 0,
      startTime: 0,
      longPressTimer: null,
      originalStartYear: 0,
      originalEndYear: 0,
      dragType: 'move',
      ghostEl: null,
      dateLabelEl: null,
    };
  }

  private reset(): void {
    this.cancelLongPress();
    if (this.ctx.dateLabelEl) {
      this.ctx.dateLabelEl.style.display = 'none';
    }
    const dateLabelEl = this.ctx.dateLabelEl;
    this.ctx = this.freshContext();
    this.ctx.dateLabelEl = dateLabelEl;
    document.body.classList.remove('sabidurian-dragging');
  }

  // ── Callback setters ──

  setSelectCallback(cb: SelectCallback): void { this.onSelect = cb; }
  setOpenCallback(cb: OpenCallback): void { this.onOpen = cb; }
  setContextMenuCallback(cb: ContextMenuCallback): void { this.onContextMenu = cb; }
  setEmptyContextMenuCallback(cb: EmptyContextMenuCallback): void { this.onEmptyContextMenu = cb; }
  setDragCompleteCallback(cb: DragCompleteCallback): void { this.onDragComplete = cb; }
  setCreateCallback(cb: CreateCallback): void { this.onCreate = cb; }
  setScaleChangeCallback(cb: ScaleChangeCallback): void { this.onScaleChange = cb; }

  destroy(): void {
    this.cancelLongPress();
    this.removeGhost();
    this.svg.removeEventListener('touchstart', this.boundTouchStart);
    this.svg.removeEventListener('touchmove', this.boundTouchMove);
    this.svg.removeEventListener('touchend', this.boundTouchEnd);
    this.svg.removeEventListener('touchcancel', this.boundTouchCancel);
    this.ctx.dateLabelEl?.remove();
    this.ctx.dateLabelEl = null;
    this.onSelect = null;
    this.onOpen = null;
    this.onContextMenu = null;
    this.onEmptyContextMenu = null;
    this.onDragComplete = null;
    this.onCreate = null;
    this.onScaleChange = null;
  }
}
