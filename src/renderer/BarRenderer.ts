/**
 * BarRenderer — Renders individual bars and point markers as SVG elements.
 * Handles labels, hover tooltips, click-to-open, and Obsidian page preview.
 */

import type { App, TFile } from 'obsidian';
import type { SabidurianEntry } from '../model/SabidurianEntry';
import { BAR_HEIGHT } from '../model/LayoutEngine';
import { formatSabidurianDate } from '../utils/dateUtils';
import type { NumericAxis } from '../scale/NumericAxis';

const SVG_NS = 'http://www.w3.org/2000/svg';
const POINT_RADIUS = 7;
const LABEL_PADDING = 8;
const MIN_LABEL_WIDTH = 40; // Don't render label inside bar if narrower than this

export class BarRenderer {
  private app: App;
  private svg: SVGSVGElement;
  private barGroup: SVGGElement;
  private tooltipEl: HTMLElement | null = null;
  private defsEl: SVGDefsElement | null = null;

  /** When true, tooltip shows ordinal position instead of dates. */
  sequenceMode = false;
  denseToSparse: number[] | null = null;

  constructor(svg: SVGSVGElement, app: App, tooltipParent: HTMLElement) {
    this.app = app;
    this.svg = svg;

    this.barGroup = document.createElementNS(SVG_NS, 'g');
    this.barGroup.classList.add('sabidurian-bars-group');
    svg.appendChild(this.barGroup);

    // Shared tooltip element
    this.tooltipEl = tooltipParent.createDiv({ cls: 'sabidurian-tooltip' });
    this.tooltipEl.style.display = 'none';
  }

  /** Optional axis reference for computing fuzzy date pixel positions. */
  private axis: NumericAxis | null = null;

  /** Property keys to display as badges on bars. Max 3. */
  private displayProps: string[] = [];
  /** Minimum bar width (px) to show badges. */
  private badgeMinWidth = 80;
  /** Whether property badges are globally enabled. */
  private badgesEnabled = true;

  /** Tag to focus on — entries without this tag are visually greyed out. */
  private focusTag: string | null = null;

  /** Set the axis for fuzzy date rendering. Call before render(). */
  setAxis(axis: NumericAxis): void {
    this.axis = axis;
  }

  /** Set date property names to exclude from tooltips. */
  setDatePropNames(startProp: string, endProp: string): void {
    this.tooltipExcludeExtra = new Set([startProp, endProp]);
  }

  /** Set the focus tag. Entries without this tag are greyed out. */
  setFocusTag(tag: string | null): void {
    this.focusTag = tag;
  }

  /** Check whether an entry's tags contain the focus tag. */
  private entryHasFocusTag(entry: SabidurianEntry): boolean {
    if (!this.focusTag) return true; // No focus tag set — everything is focused
    const needle = this.focusTag.toLowerCase();
    // Check all property values whose key looks like "tags" or "tag"
    for (const [key, val] of Object.entries(entry.properties)) {
      if (key.toLowerCase().includes('tag') && val) {
        // Tags arrive as comma-separated string, e.g. "project,work,v2"
        const tags = val.split(',').map(t => t.trim().replace(/^#/, '').toLowerCase());
        if (tags.includes(needle)) return true;
      }
    }
    return false;
  }

  /** Configure property badge display. Call before render(). */
  setDisplayProps(props: string[], minWidth: number, enabled: boolean): void {
    this.displayProps = props.filter(Boolean).slice(0, 3);
    this.badgeMinWidth = minWidth;
    this.badgesEnabled = enabled;
  }

  render(entries: SabidurianEntry[], getRowY: (row: number) => number): void {
    // Clear previous bars
    while (this.barGroup.firstChild) {
      this.barGroup.removeChild(this.barGroup.firstChild);
    }

    for (const entry of entries) {
      const y = getRowY(entry.row);

      if (entry.isPoint) {
        this.renderPointMarker(entry, y);
      } else {
        this.renderBar(entry, y);
      }
    }
  }

  private renderBar(entry: SabidurianEntry, y: number): void {
    const group = document.createElementNS(SVG_NS, 'g');
    group.classList.add('sabidurian-bar-group');
    if (this.focusTag && !this.entryHasFocusTag(entry)) {
      group.classList.add('sabidurian-bar-unfocused');
    }
    group.dataset.filePath = entry.file.path;

    // ── Fuzzy/uncertainty extensions (rendered BEFORE main bar) ──
    if (this.axis) {
      if (entry.earliestStartYear != null && entry.earliestStartYear < entry.startYear) {
        const earlyX = this.axis.yearToPixel(entry.earliestStartYear);
        const earlyWidth = entry.x - earlyX;
        if (earlyWidth > 0) {
          const uncertainLeft = document.createElementNS(SVG_NS, 'rect');
          uncertainLeft.setAttribute('x', `${earlyX}`);
          uncertainLeft.setAttribute('y', `${y}`);
          uncertainLeft.setAttribute('width', `${earlyWidth}`);
          uncertainLeft.setAttribute('height', `${BAR_HEIGHT}`);
          uncertainLeft.setAttribute('rx', '4');
          uncertainLeft.classList.add('sabidurian-uncertain-range');
          uncertainLeft.style.fill = entry.color;
          group.appendChild(uncertainLeft);
        }
      }

      if (entry.latestEndYear != null && entry.latestEndYear > entry.endYear) {
        const barRight = entry.x + entry.width;
        const lateX = this.axis.yearToPixel(entry.latestEndYear);
        const lateWidth = lateX - barRight;
        if (lateWidth > 0) {
          const uncertainRight = document.createElementNS(SVG_NS, 'rect');
          uncertainRight.setAttribute('x', `${barRight}`);
          uncertainRight.setAttribute('y', `${y}`);
          uncertainRight.setAttribute('width', `${lateWidth}`);
          uncertainRight.setAttribute('height', `${BAR_HEIGHT}`);
          uncertainRight.setAttribute('rx', '4');
          uncertainRight.classList.add('sabidurian-uncertain-range');
          uncertainRight.style.fill = entry.color;
          group.appendChild(uncertainRight);
        }
      }
    }

    // Bar rect
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', `${entry.x}`);
    rect.setAttribute('y', `${y}`);
    rect.setAttribute('width', `${entry.width}`);
    rect.setAttribute('height', `${BAR_HEIGHT}`);
    rect.setAttribute('rx', '4');
    rect.setAttribute('ry', '4');
    rect.style.fill = entry.color;
    rect.classList.add('sabidurian-bar');
    if (entry.fuzzyOnly) {
      group.classList.add('sabidurian-bar-fuzzy-only');
    }
    group.appendChild(rect);

    // Resize grip indicators (visible on hover)
    if (entry.width > 30) {
      const gripLeft = document.createElementNS(SVG_NS, 'g');
      gripLeft.classList.add('sabidurian-resize-grip', 'sabidurian-resize-grip-left');
      for (let i = -2; i <= 2; i += 2) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', `${entry.x + 4 + i}`);
        line.setAttribute('x2', `${entry.x + 4 + i}`);
        line.setAttribute('y1', `${y + 6}`);
        line.setAttribute('y2', `${y + BAR_HEIGHT - 6}`);
        gripLeft.appendChild(line);
      }
      group.appendChild(gripLeft);

      const gripRight = document.createElementNS(SVG_NS, 'g');
      gripRight.classList.add('sabidurian-resize-grip', 'sabidurian-resize-grip-right');
      for (let i = -2; i <= 2; i += 2) {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', `${entry.x + entry.width - 4 + i}`);
        line.setAttribute('x2', `${entry.x + entry.width - 4 + i}`);
        line.setAttribute('y1', `${y + 6}`);
        line.setAttribute('y2', `${y + BAR_HEIGHT - 6}`);
        gripRight.appendChild(line);
      }
      group.appendChild(gripRight);
    }

    // Label: inside bar if wide enough, otherwise to the right
    const text = document.createElementNS(SVG_NS, 'text');
    text.classList.add('sabidurian-bar-label');
    text.setAttribute('y', `${y + BAR_HEIGHT / 2 + 4}`);
    text.textContent = entry.label;

    if (entry.width >= MIN_LABEL_WIDTH) {
      // Inside bar, clipped
      text.setAttribute('x', `${entry.x + LABEL_PADDING}`);
      text.classList.add('sabidurian-bar-label-inside');

      // Clip path to bar bounds
      const clipId = `clip-${entry.file.path.replace(/[^a-zA-Z0-9]/g, '-')}`;
      const clipPath = document.createElementNS(SVG_NS, 'clipPath');
      clipPath.id = clipId;
      const clipRect = document.createElementNS(SVG_NS, 'rect');
      clipRect.setAttribute('x', `${entry.x}`);
      clipRect.setAttribute('y', `${y}`);
      clipRect.setAttribute('width', `${entry.width}`);
      clipRect.setAttribute('height', `${BAR_HEIGHT}`);
      clipPath.appendChild(clipRect);
      group.appendChild(clipPath);
      text.setAttribute('clip-path', `url(#${clipId})`);
    } else {
      // To the right of bar
      text.setAttribute('x', `${entry.x + entry.width + 6}`);
      text.classList.add('sabidurian-bar-label-outside');
    }
    group.appendChild(text);

    // ── Inline property values (displayed right of label) ──
    if (this.badgesEnabled && this.displayProps.length > 0 && entry.width >= this.badgeMinWidth) {
      // Collect non-empty property values
      const propParts: string[] = [];
      for (const prop of this.displayProps) {
        const value = entry.properties[prop];
        if (value && value !== 'null') {
          propParts.push(String(value).replace(/\[\[|\]\]/g, '').slice(0, 20));
        }
      }
      if (propParts.length > 0) {
        const inlineText = propParts.join(' · ');
        // Estimate label width (approx 7px per char for the main label font)
        const labelWidth = entry.label.length * 7 + LABEL_PADDING;
        const propX = entry.x + labelWidth + 8;
        const propY = y + BAR_HEIGHT / 2 + 4;

        const propEl = document.createElementNS(SVG_NS, 'text');
        propEl.setAttribute('x', `${propX}`);
        propEl.setAttribute('y', `${propY}`);
        propEl.textContent = inlineText;
        propEl.classList.add('sabidurian-bar-prop-inline');

        // Apply same clip-path as label so text doesn't overflow bar
        if (entry.width >= MIN_LABEL_WIDTH) {
          const clipId = `clip-${entry.file.path.replace(/[^a-zA-Z0-9]/g, '-')}`;
          propEl.setAttribute('clip-path', `url(#${clipId})`);
        }
        group.appendChild(propEl);
      }
    }

    // ── Per-note lock indicator (Lucide-style SVG lock) ──
    if (entry.locked) {
      group.classList.add('sabidurian-bar-locked');

      const iconSize = 12;
      const iconX = entry.isPoint
        ? entry.x + POINT_RADIUS + 2
        : entry.x + entry.width - iconSize - 3;
      const iconY = y + 2;

      const lockG = document.createElementNS(SVG_NS, 'g');
      lockG.classList.add('sabidurian-lock-indicator');
      lockG.setAttribute('transform', `translate(${iconX}, ${iconY}) scale(${iconSize / 24})`);

      // Lucide lock path: shackle (arc) + body (rect)
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2.5');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      lockG.appendChild(path);
      group.appendChild(lockG);
    }

    // ── Ongoing event treatment: gradient fade + dashed class ──
    if (entry.isOngoing) {
      group.classList.add('sabidurian-bar-ongoing');

      // Gradient overlay on right 20% of bar
      const gradientId = `ongoing-fade-${entry.file.path.replace(/[^a-zA-Z0-9]/g, '-')}`;
      const defs = this.ensureDefs();
      const gradient = document.createElementNS(SVG_NS, 'linearGradient');
      gradient.id = gradientId;
      gradient.setAttribute('x1', '0.8');
      gradient.setAttribute('x2', '1');
      gradient.setAttribute('y1', '0');
      gradient.setAttribute('y2', '0');

      const stop1 = document.createElementNS(SVG_NS, 'stop');
      stop1.setAttribute('offset', '0%');
      stop1.setAttribute('stop-color', 'white');
      stop1.setAttribute('stop-opacity', '0');

      const stop2 = document.createElementNS(SVG_NS, 'stop');
      stop2.setAttribute('offset', '100%');
      stop2.setAttribute('stop-color', 'white');
      stop2.setAttribute('stop-opacity', '0.6');

      gradient.append(stop1, stop2);
      defs.appendChild(gradient);

      const fadeRect = document.createElementNS(SVG_NS, 'rect');
      fadeRect.setAttribute('x', `${entry.x}`);
      fadeRect.setAttribute('y', `${y}`);
      fadeRect.setAttribute('width', `${entry.width}`);
      fadeRect.setAttribute('height', `${BAR_HEIGHT}`);
      fadeRect.setAttribute('rx', '4');
      fadeRect.setAttribute('fill', `url(#${gradientId})`);
      fadeRect.classList.add('sabidurian-ongoing-fade');
      group.appendChild(fadeRect);
    }

    // Interactions
    this.addInteractions(group, entry);
    this.barGroup.appendChild(group);
  }

  /** Get or create a shared <defs> element in the SVG. */
  private ensureDefs(): SVGDefsElement {
    if (this.defsEl) return this.defsEl;
    let defs = this.svg.querySelector('defs') as SVGDefsElement | null;
    if (!defs) {
      defs = document.createElementNS(SVG_NS, 'defs');
      this.svg.insertBefore(defs, this.svg.firstChild);
    }
    this.defsEl = defs;
    return defs;
  }

  private renderPointMarker(entry: SabidurianEntry, y: number): void {
    const group = document.createElementNS(SVG_NS, 'g');
    group.classList.add('sabidurian-bar-group');
    if (this.focusTag && !this.entryHasFocusTag(entry)) {
      group.classList.add('sabidurian-bar-unfocused');
    }
    group.dataset.filePath = entry.file.path;

    const cx = entry.x;
    const cy = y + BAR_HEIGHT / 2;
    const r = POINT_RADIUS;

    // Diamond shape
    const diamond = document.createElementNS(SVG_NS, 'polygon');
    diamond.setAttribute('points',
      `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`);
    diamond.style.fill = entry.color;
    diamond.classList.add('sabidurian-point-marker');
    group.appendChild(diamond);

    // Label to the right
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', `${cx + r + 6}`);
    text.setAttribute('y', `${cy + 4}`);
    text.classList.add('sabidurian-bar-label', 'sabidurian-bar-label-outside');
    text.textContent = entry.label;
    group.appendChild(text);

    this.addInteractions(group, entry);
    this.barGroup.appendChild(group);
  }

  private addInteractions(group: SVGGElement, entry: SabidurianEntry): void {
    // Click to open note
    group.addEventListener('click', (e) => {
      e.preventDefault();
      const leaf = this.app.workspace.getLeaf(false);
      leaf.openFile(entry.file);
    });

    // Hover: show tooltip
    group.addEventListener('mouseenter', (e) => {
      this.showTooltip(entry, e);
      group.classList.add('sabidurian-bar-hover');
    });
    group.addEventListener('mouseleave', () => {
      this.hideTooltip();
      group.classList.remove('sabidurian-bar-hover');
    });
    group.addEventListener('mousemove', (e) => {
      this.moveTooltip(e);
    });

    // Trigger Obsidian page preview on hover
    group.addEventListener('mouseover', (e) => {
      this.app.workspace.trigger('hover-link', {
        event: e,
        source: 'sabidurian-timeline',
        hoverParent: group,
        targetEl: group,
        linktext: entry.file.path,
        sourcePath: entry.file.path,
      });
    });

    group.style.cursor = 'pointer';
  }

  /** Property key prefixes to exclude from tooltip (system/file metadata). */
  private static readonly TOOLTIP_EXCLUDE_BASE = new Set([
    'file name', 'file base name', 'file full name', 'file path',
    'file extension', 'folder', 'file size',
    'created time', 'modified time',
  ]);

  /** Additional property keys to exclude (configured date property names). */
  private tooltipExcludeExtra: Set<string> = new Set(['start-date', 'end-date']);

  /** Build tooltip content using safe DOM methods (no innerHTML). */
  private showTooltip(entry: SabidurianEntry, e: MouseEvent): void {
    if (!this.tooltipEl) return;

    // Clear previous content
    this.tooltipEl.empty();

    const strong = this.tooltipEl.createEl('strong');
    strong.textContent = entry.label;

    if (this.sequenceMode) {
      const d2s = this.denseToSparse;
      const rawStart = Math.round(entry.startYear);
      const rawEnd = Math.round(entry.endYear) - 1;
      const startPos = d2s ? (d2s[rawStart - 1] ?? rawStart) : rawStart;
      const endPos = d2s ? (d2s[rawEnd - 1] ?? rawEnd) : rawEnd;
      this.tooltipEl.createEl('br');
      this.tooltipEl.appendText(
        endPos > startPos ? `Position ${startPos} → ${endPos}` : `Position ${startPos}`,
      );
    } else {
      this.tooltipEl.createEl('br');
      let dateText = formatSabidurianDate(entry.start);
      if (entry.isOngoing) {
        dateText += ' → present (ongoing)';
      } else if (entry.end && !entry.isPoint) {
        dateText += ` → ${formatSabidurianDate(entry.end)}`;
      } else if (entry.isPoint) {
        dateText += ' (point event)';
      }
      this.tooltipEl.appendText(dateText);
    }

    // Fuzzy date info
    if (entry.earliestStart) {
      this.tooltipEl.createEl('br');
      const span = this.tooltipEl.createEl('span', { cls: 'sabidurian-tooltip-prop' });
      span.textContent = 'Earliest start:';
      this.tooltipEl.appendText(` ${formatSabidurianDate(entry.earliestStart)}`);
    }
    if (entry.latestEnd) {
      this.tooltipEl.createEl('br');
      const span = this.tooltipEl.createEl('span', { cls: 'sabidurian-tooltip-prop' });
      span.textContent = 'Latest end:';
      this.tooltipEl.appendText(` ${formatSabidurianDate(entry.latestEnd)}`);
    }

    // User-defined properties (safe: textContent only)
    for (const [key, val] of Object.entries(entry.properties)) {
      const keyLower = key.toLowerCase();
      if (val && val !== 'null' && !BarRenderer.TOOLTIP_EXCLUDE_BASE.has(keyLower) && !this.tooltipExcludeExtra.has(keyLower)) {
        this.tooltipEl.createEl('br');
        const span = this.tooltipEl.createEl('span', { cls: 'sabidurian-tooltip-prop' });
        span.textContent = `${key}:`;
        this.tooltipEl.appendText(` ${val}`);
      }
    }

    this.tooltipEl.style.display = 'block';
    this.moveTooltip(e);
  }

  private moveTooltip(e: MouseEvent): void {
    if (!this.tooltipEl) return;
    // Position tooltip close to cursor — slightly right and above
    const gapX = 12;
    const gapY = 8;
    const tw = this.tooltipEl.offsetWidth || 200;
    const th = this.tooltipEl.offsetHeight || 60;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 6;

    // Default: right of cursor, above cursor
    let x = e.clientX + gapX;
    let y = e.clientY - gapY - th;

    // Flip horizontally if it would overflow
    if (x + tw > vw - margin) x = e.clientX - tw - gapX;
    // Flip vertically if it would go above viewport
    if (y < margin) y = e.clientY + gapY;
    // Clamp bottom
    if (y + th > vh - margin) y = vh - th - margin;

    this.tooltipEl.style.left = `${x}px`;
    this.tooltipEl.style.top = `${y}px`;
  }

  private hideTooltip(): void {
    if (!this.tooltipEl) return;
    this.tooltipEl.style.display = 'none';
  }

  destroy(): void {
    this.tooltipEl?.remove();
    this.tooltipEl = null;
  }
}
