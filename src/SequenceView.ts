/**
 * SequenceView — Ordinal (non-temporal) variant of SabidurianView.
 *
 * Renders notes as bars on a numbered sequence axis (1, 2, 3, …)
 * driven by a numeric "order" frontmatter property instead of dates.
 *
 * Reuses all existing renderers (BarRenderer, HeaderRenderer,
 * TimelineRenderer, SideTableRenderer, ArrowRenderer, etc.).
 * The key differences from SabidurianView:
 *   1. Axis range is ordinal (integers), not fractional years
 *   2. parseEntries reads an "order" property (number) instead of dates
 *   3. Drag write-back writes integer order values + renumbers siblings
 *   4. No today marker, no BCE support, no time scales
 *   5. Single-step entries are rendered as full-column bars (not points)
 */

import { BasesView, Notice, QueryController, setIcon } from 'obsidian';
import type { BasesPropertyId, TFile } from 'obsidian';
import type SabidurianPlugin from './main';
import { NumericAxis } from './scale/NumericAxis';
import { createSequenceScale } from './scale/SequenceScale';
import type { TimeScale } from './scale/TimeScale';
import { HeaderRenderer } from './renderer/HeaderRenderer';
import { TimelineRenderer } from './renderer/TimelineRenderer';
import { BarRenderer } from './renderer/BarRenderer';
import { SideTableRenderer, type TableColumn } from './renderer/SideTableRenderer';
import { LayoutEngine, ROW_HEIGHT } from './model/LayoutEngine';
import type { SabidurianEntry, SabidurianGroup } from './model/SabidurianEntry';
import { GroupHeaderRenderer } from './renderer/GroupHeaderRenderer';
import { getColorForValue, resetColorCache } from './utils/colorUtils';
import { DragManager } from './interaction/DragManager';
import { ArrowRenderer } from './renderer/ArrowRenderer';
import { ArrowDragManager } from './interaction/ArrowDragManager';
import { ContextMenuManager } from './interaction/ContextMenuManager';
import { KeyboardManager } from './interaction/KeyboardManager';
import { SelectionManager } from './interaction/SelectionManager';
import { TouchManager } from './interaction/TouchManager';
import { isTouchDevice, isMobileViewport, debounce } from './utils/debounce';
import { ViewportCuller, type ViewportBounds } from './model/ViewportCuller';
import { confirmAction } from './utils/confirmModal';

const VIEW_PADDING = 0.5; // Half-step padding on each side
const MIN_TIMELINE_HEIGHT = 200;
const CULLING_THRESHOLD = 150;
const SYSTEM_PROP_PREFIXES = ['file.', 'formula.'];

/** Column width in pixels for each ordinal step. */
const STEP_WIDTH_PX = 100;

export class SequenceView extends BasesView {
  type = 'sabidurian-sequence';

  private scrollEl: HTMLElement;
  private rootEl: HTMLElement | null = null;
  private plugin: SabidurianPlugin;

  // Renderers
  private headerRenderer: HeaderRenderer | null = null;
  private timelineRenderer: TimelineRenderer | null = null;
  private barRenderer: BarRenderer | null = null;
  private sideTableRenderer: SideTableRenderer | null = null;
  private dragManager: DragManager | null = null;
  private arrowRenderer: ArrowRenderer | null = null;
  private arrowDragManager: ArrowDragManager | null = null;
  private contextMenuManager: ContextMenuManager | null = null;
  private keyboardManager: KeyboardManager | null = null;
  private selectionManager: SelectionManager | null = null;
  private touchManager: TouchManager | null = null;
  private groupHeaderRenderer: GroupHeaderRenderer | null = null;
  private layoutEngine: LayoutEngine = new LayoutEngine();

  private debouncedRender = debounce(() => this.onDataUpdated(), 16);

  // Axis & scale
  private axis: NumericAxis = new NumericAxis(0, 10, 800);
  private currentScale: TimeScale | null = null;

  // Parsed entries
  private currentEntries: SabidurianEntry[] = [];
  private currentGroups: SabidurianGroup[] = [];
  private collapsedGroups: Set<string> = new Set();

  // Lock state
  private _locked = false;

  // Viewport culling
  private viewportCuller: ViewportCuller | null = null;
  private allVisibleEntries: SabidurianEntry[] = [];
  private cullingActive = false;
  private lastViewportBounds: ViewportBounds | null = null;
  private debouncedViewportRender = debounce(() => this.renderVisibleBars(), 0);
  private _showArrows = true;
  private _isGrouped = false;

  /** All entries in the current dataset (for reorder write-back). */
  private _allParsedEntries: SabidurianEntry[] = [];
  /** The order property (raw frontmatter key) being used. */
  private _orderPropName: string = 'order';
  /** The order-end property (raw frontmatter key), or null if not configured. */
  private _orderEndPropName: string | null = null;
  /** In dense mode, maps dense index (0-based) → original order value. Null when sparse. */
  private _denseToSparse: number[] | null = null;

  constructor(controller: QueryController, scrollEl: HTMLElement, plugin: SabidurianPlugin) {
    super(controller);
    this.scrollEl = scrollEl;
    this.plugin = plugin;
    this.renderSkeleton();
  }

  onDataUpdated(): void {
    const prevScrollLeft = this.timelineRenderer?.element.scrollLeft ?? 0;
    const prevScrollTop = this.timelineRenderer?.element.scrollTop ?? 0;

    // Clean up
    this.destroyManagers();
    if (this.rootEl) this.rootEl.remove();
    // Defensive cleanup for stale siblings (see SabidurianView for context).
    this.scrollEl
      .querySelectorAll(':scope > .sabidurian-container')
      .forEach((el) => el.remove());
    this.rootEl = this.scrollEl.createDiv({ cls: 'sabidurian-container sabidurian-sequence-container' });

    const entries = this.data?.data ?? [];
    if (entries.length === 0) {
      this.renderEmptyState();
      return;
    }

    // Read config
    const orderPropId = this.config.getAsPropertyId('orderProp');
    const orderEndPropId = this.config.getAsPropertyId('orderEndProp');
    const colorPropId = this.config.getAsPropertyId('colorProp');
    const depPropRaw = this.config.get('dependencyProp') as string | undefined;
    const depPropName = depPropRaw?.trim() || this.plugin.settings.dependencyProperty || 'blocked-by';
    const denseMode = this.config.get('denseMode') as boolean ?? false;

    // Store raw frontmatter keys for write-back.
    // Bases property IDs are prefixed with "note." — strip it for frontmatter access.
    this._orderPropName = orderPropId
      ? orderPropId.replace(/^note\./, '')
      : 'order';
    this._orderEndPropName = orderEndPropId
      ? orderEndPropId.replace(/^note\./, '')
      : null;

    // Detect groups
    const groupedData = this.data?.groupedData ?? [];
    const isGrouped = groupedData.length > 1 ||
      (groupedData.length === 1 && groupedData[0].hasKey());

    // Restore collapsed state
    const savedCollapsed = this.config.get('collapsedGroups') as string[] | undefined;
    if (savedCollapsed) this.collapsedGroups = new Set(savedCollapsed);

    // Parse entries
    resetColorCache();
    let sabidurianEntries: SabidurianEntry[];
    let sabidurianGroups: SabidurianGroup[] = [];

    if (isGrouped) {
      sabidurianGroups = [];
      sabidurianEntries = [];
      for (const group of groupedData) {
        const groupName = group.hasKey() ? String(group.key) : '(No value)';
        const parsed = this.parseSequenceEntries(
          group.entries, orderPropId, orderEndPropId, colorPropId, depPropName,
        );
        for (const e of parsed) e.groupKey = groupName;
        sabidurianEntries.push(...parsed);
        sabidurianGroups.push({
          name: groupName,
          entries: parsed,
          collapsed: this.collapsedGroups.has(groupName),
          headerY: 0,
          totalHeight: 0,
        });
      }
    } else {
      sabidurianEntries = this.parseSequenceEntries(
        entries, orderPropId, orderEndPropId, colorPropId, depPropName,
      );
    }

    this.currentEntries = sabidurianEntries;
    this.currentGroups = sabidurianGroups;
    this._allParsedEntries = sabidurianEntries;

    if (sabidurianEntries.length === 0) {
      this.renderEmptyState('No entries have a valid order value. Configure the Order property above.');
      return;
    }

    // Performance warning
    if (sabidurianEntries.length > this.plugin.settings.maxEntries) {
      new Notice(
        `Time & Line: ${sabidurianEntries.length} entries exceed the ${this.plugin.settings.maxEntries} limit. Performance may degrade.`,
        8000,
      );
    }

    // Collect ALL occupied integer positions (including span interiors)
    const allOccupied = new Set<number>();
    for (const e of sabidurianEntries) {
      for (let p = Math.floor(e.startYear); p < e.endYear; p++) {
        allOccupied.add(p);
      }
    }
    const sortedOccupied = [...allOccupied].sort((a, b) => a - b);

    let viewStart: number;
    let viewEnd: number;
    let stepCount: number;
    this._denseToSparse = null;

    if (denseMode && sortedOccupied.length > 0) {
      // Build sparse → dense mapping
      const sparseToDense = new Map<number, number>();
      for (let i = 0; i < sortedOccupied.length; i++) {
        sparseToDense.set(sortedOccupied[i], i + 1); // 1-based dense index
      }
      this._denseToSparse = sortedOccupied; // reverse: denseIdx-1 → original order

      // Remap entry positions to dense indices
      for (const e of sabidurianEntries) {
        const dStart = sparseToDense.get(Math.floor(e.startYear));
        const dEndPos = sparseToDense.get(Math.floor(e.endYear - 1)); // last occupied position
        if (dStart != null) e.startYear = dStart;
        if (dEndPos != null) e.endYear = dEndPos + 1; // exclusive end
      }

      const denseCount = sortedOccupied.length;
      viewStart = 1 - VIEW_PADDING;
      viewEnd = denseCount + 1 + VIEW_PADDING;
      stepCount = denseCount;
    } else {
      const occupiedStarts = sabidurianEntries.map(e => e.startYear);
      const minPos = Math.min(...occupiedStarts);
      const maxPos = Math.max(
        ...sabidurianEntries.map(e => e.endYear),
        ...occupiedStarts,
      );
      viewStart = minPos - VIEW_PADDING;
      viewEnd = maxPos + VIEW_PADDING;
      stepCount = Math.ceil(viewEnd - viewStart);
    }

    // Create sequence scale (pass original positions for column labels)
    this.currentScale = createSequenceScale(sortedOccupied, denseMode);

    // Canvas width: each step gets STEP_WIDTH_PX
    const containerWidth = this.rootEl.clientWidth || 800;
    const canvasWidth = Math.max(containerWidth, stepCount * STEP_WIDTH_PX);
    this.axis.setView(viewStart, viewEnd, canvasWidth);

    // Lock state
    const configLocked = this.config.get('locked') as boolean ?? false;
    const autoLock = this.plugin.settings.lockOnMobile && isTouchDevice();
    this._locked = configLocked || autoLock;

    // Controls bar
    this.renderControls(sabidurianEntries.length);

    // Columns
    const columns = this.currentScale.getColumnBoundaries(viewStart, viewEnd);

    // Body layout
    const bodyContainerEl = this.rootEl.createDiv({ cls: 'sabidurian-body-container' });
    const headerContainerEl = bodyContainerEl.createDiv({ cls: 'sabidurian-header-container' });

    const isMobile = isMobileViewport();
    const showTable = isMobile ? false : (this.config.get('showTable') as boolean ?? true);
    const savedTableWidth = this.config.get('tableWidth') as number | undefined;
    const tableColumns = this.getTableColumns(orderPropId, orderEndPropId);

    if (showTable) {
      const tableHeaderSpacer = headerContainerEl.createDiv({ cls: 'sabidurian-table-header-spacer' });
      tableHeaderSpacer.style.width = `${savedTableWidth ?? 220}px`;
      tableHeaderSpacer.style.flexShrink = '0';
    }

    // Header — single-tier for sequence (just numbers)
    const timelineHeaderEl = headerContainerEl.createDiv({ cls: 'sabidurian-timeline-header-wrap' });
    this.headerRenderer = new HeaderRenderer(timelineHeaderEl);
    this.headerRenderer.render(columns, this.axis);

    const contentEl = bodyContainerEl.createDiv({ cls: 'sabidurian-content-row' });

    // Layout
    let canvasHeight: number;
    let visibleEntries: SabidurianEntry[];

    if (isGrouped) {
      const totalHeight = this.layoutEngine.layoutGrouped(sabidurianGroups, this.axis);
      canvasHeight = Math.max(MIN_TIMELINE_HEIGHT, totalHeight);
      visibleEntries = sabidurianEntries.filter(e => e.row >= 0);
    } else {
      const totalHeight = this.layoutEngine.layout(sabidurianEntries, this.axis);
      canvasHeight = Math.max(MIN_TIMELINE_HEIGHT, totalHeight);
      visibleEntries = sabidurianEntries;
    }

    // Side table
    if (showTable) {
      this.sideTableRenderer = new SideTableRenderer(
        contentEl, this.plugin.app, savedTableWidth,
      );

      if (isGrouped) {
        this.sideTableRenderer.renderGrouped(
          sabidurianGroups, sabidurianEntries, tableColumns,
          (row) => this.layoutEngine.getRowY(row),
        );
        this.sideTableRenderer.setGroupToggleCallback((groupName) => {
          this.toggleGroup(groupName);
        });
      } else {
        this.sideTableRenderer.render(
          sabidurianEntries, tableColumns,
          (row) => this.layoutEngine.getRowY(row),
        );
      }

      this.sideTableRenderer.setWidthChangeCallback((w) => {
        this.config.set('tableWidth', w);
        const spacer = headerContainerEl.querySelector('.sabidurian-table-header-spacer') as HTMLElement;
        if (spacer) spacer.style.width = `${w}px`;
      });

      this.sideTableRenderer.setRowHoverCallback((idx) => {
        this.highlightBar(idx);
      });
    }

    // Timeline canvas (no today marker)
    this.timelineRenderer = new TimelineRenderer(contentEl);
    this.timelineRenderer.render(columns, this.axis, canvasHeight, false);

    // Viewport culling
    this._showArrows = this.config.get('showArrows') as boolean ?? true;
    this._isGrouped = isGrouped;
    this.allVisibleEntries = visibleEntries;
    this.cullingActive = visibleEntries.length > CULLING_THRESHOLD;
    this.lastViewportBounds = null;
    this.viewportCuller = new ViewportCuller((row) => this.layoutEngine.getRowY(row));

    this.barRenderer = new BarRenderer(
      this.timelineRenderer.svgElement,
      this.plugin.app,
      this.rootEl,
    );
    this.barRenderer.sequenceMode = true;
    this.barRenderer.denseToSparse = this._denseToSparse;

    // Bar display props (F4)
    const barDisplayProps: string[] = [];
    for (const key of ['barDisplayProp1', 'barDisplayProp2', 'barDisplayProp3']) {
      const val = this.config.get(key) as string | undefined;
      if (val) {
        barDisplayProps.push(val.replace(/^note\./, ''));
      }
    }
    this.barRenderer.setDisplayProps(
      barDisplayProps,
      this.plugin.settings.barPropertyMinWidth,
      this.plugin.settings.showBarProperties,
    );

    // Focus tag: grey out entries that don't have this tag
    const focusTagRaw = (this.config.get('focusTag') as string | undefined)?.trim() || null;
    this.barRenderer.setFocusTag(focusTagRaw ? focusTagRaw.replace(/^#/, '') : null);

    // Group headers
    if (isGrouped) {
      this.groupHeaderRenderer = new GroupHeaderRenderer(
        this.timelineRenderer.svgElement,
      );
      this.groupHeaderRenderer.render(sabidurianGroups, canvasWidth);
      this.groupHeaderRenderer.setToggleCallback((groupName) => {
        this.toggleGroup(groupName);
      });
    }

    // Detect dependency cycles
    if (this._showArrows) {
      this.detectCycles(sabidurianEntries);
    }

    // Initial bar render
    this.renderVisibleBars();

    // Scroll sync
    const timelineBody = this.timelineRenderer.element;

    timelineBody.addEventListener('scroll', () => {
      this.headerRenderer?.setScrollLeft(timelineBody.scrollLeft);
      if (this.cullingActive) {
        this.debouncedViewportRender();
      }
    });

    if (this.sideTableRenderer) {
      const tableBody = this.sideTableRenderer.scrollBody;
      timelineBody.addEventListener('scroll', () => {
        tableBody.scrollTop = timelineBody.scrollTop;
      });
      tableBody.addEventListener('scroll', () => {
        timelineBody.scrollTop = tableBody.scrollTop;
      });
    }

    // Restore scroll position
    if (prevScrollLeft || prevScrollTop) {
      requestAnimationFrame(() => {
        timelineBody.scrollLeft = prevScrollLeft;
        timelineBody.scrollTop = prevScrollTop;
        this.headerRenderer?.setScrollLeft(prevScrollLeft);
        if (this.sideTableRenderer) {
          this.sideTableRenderer.scrollBody.scrollTop = prevScrollTop;
        }
        if (this.cullingActive) {
          this.renderVisibleBars();
        }
      });
    }
  }

  // ─── Render visible bars (viewport-culled) + interaction managers ───

  private renderVisibleBars(): void {
    if (!this.timelineRenderer || !this.barRenderer || !this.rootEl) return;

    const timelineBody = this.timelineRenderer.element;

    let entriesToRender: SabidurianEntry[];

    if (this.cullingActive && this.viewportCuller) {
      const bounds: ViewportBounds = {
        scrollLeft: timelineBody.scrollLeft,
        scrollTop: timelineBody.scrollTop,
        viewportWidth: timelineBody.clientWidth,
        viewportHeight: timelineBody.clientHeight,
      };
      if (!ViewportCuller.shouldRecull(this.lastViewportBounds, bounds)) return;
      this.lastViewportBounds = bounds;
      entriesToRender = this.viewportCuller.cull(this.allVisibleEntries, bounds);
    } else {
      entriesToRender = this.allVisibleEntries;
    }

    // Tear down interaction managers
    this.dragManager?.destroy(); this.dragManager = null;
    this.arrowDragManager?.destroy(); this.arrowDragManager = null;
    this.contextMenuManager?.destroy(); this.contextMenuManager = null;
    this.keyboardManager?.destroy(); this.keyboardManager = null;
    this.selectionManager?.destroy(); this.selectionManager = null;
    this.touchManager?.destroy(); this.touchManager = null;
    this.arrowRenderer?.destroy(); this.arrowRenderer = null;

    // Render bars
    this.barRenderer.render(entriesToRender, (row) => this.layoutEngine.getRowY(row));

    // Arrows
    if (this._showArrows) {
      this.arrowRenderer = new ArrowRenderer(
        this.timelineRenderer.svgElement,
        this.plugin.app,
      );
      this.arrowRenderer.render(
        entriesToRender,
        (row) => this.layoutEngine.getRowY(row),
      );

      if (!this._locked) {
        this.arrowDragManager = new ArrowDragManager(
          this.timelineRenderer.svgElement,
          this.plugin.app,
        );
        this.arrowDragManager.attach(
          this.arrowRenderer.handles,
          entriesToRender,
          (row) => this.layoutEngine.getRowY(row),
        );
        this.arrowDragManager.setConnectCompleteCallback(() => {
          setTimeout(() => this.onDataUpdated(), 200);
        });
      }
    }

    // Drag interactions — sequence-aware
    if (!this._locked) {
      this.dragManager = new DragManager(
        this.timelineRenderer.svgElement,
        this.timelineRenderer.element,
        this.plugin.app,
        this.axis,
        this.currentScale!,
      );
      this.dragManager.attachToBarGroups(
        entriesToRender,
        (row) => this.layoutEngine.getRowY(row),
      );
      this.dragManager.setDragCompleteCallback(() => {
        setTimeout(() => this.onDataUpdated(), 200);
      });

      // Override the drag write-back for sequence reordering
      this.dragManager.setSequenceMode({
        orderPropName: this._orderPropName,
        orderEndPropName: this._orderEndPropName,
        allEntries: this._allParsedEntries,
        app: this.plugin.app,
        denseToSparse: this._denseToSparse ?? undefined,
      });

      this.dragManager.setCreateCallback(async (startPos, endPos) => {
        const orderVal = this.denseToOrder(Math.round(startPos));
        const orderEnd = this.denseToOrder(Math.round(endPos));
        const fm: Record<string, any> = {};
        fm[this._orderPropName] = orderVal;
        if (orderEnd > orderVal) {
          // Strip "note." prefix for raw frontmatter key
          const orderEndPropId = this.config.getAsPropertyId('orderEndProp');
          const orderEndKey = orderEndPropId
            ? orderEndPropId.replace(/^note\./, '')
            : null;
          if (orderEndKey) {
            fm[orderEndKey] = orderEnd;
          }
        }
        await this.createFileForView(undefined, (frontmatter) => {
          Object.assign(frontmatter, fm);
        });
      });
    }

    // Selection
    this.selectionManager = new SelectionManager(this.timelineRenderer.svgElement);
    this.selectionManager.attach(entriesToRender);

    // Context menus (sequence variant — no "Jump to today", no scale change)
    this.contextMenuManager = new ContextMenuManager(
      this.timelineRenderer.svgElement,
      this.plugin.app,
      this.axis,
      this.currentScale!,
    );
    this.contextMenuManager.lockedProperty = this.plugin.settings.lockedProperty || 'locked';
    this.contextMenuManager.attach(
      entriesToRender,
      (row) => this.layoutEngine.getRowY(row),
    );
    this.contextMenuManager.setCreateCallback(async (startPos, endPos) => {
      const orderVal = this.denseToOrder(Math.round(startPos));
      const fm: Record<string, any> = {};
      fm[this._orderPropName] = orderVal;
      await this.createFileForView(undefined, (frontmatter) => {
        Object.assign(frontmatter, fm);
      });
    });
    // No scrollToToday or changeScale callbacks for sequence view
    this.contextMenuManager.setRefreshCallback(() => {
      setTimeout(() => this.onDataUpdated(), 200);
    });

    // Keyboard
    this.keyboardManager = new KeyboardManager(
      this.rootEl,
      this.plugin.app,
      this.selectionManager,
      'sequence',
    );
    this.keyboardManager.attach(this.allVisibleEntries);
    this.keyboardManager.setDeleteEntryCallback(async (entry) => {
      const confirmed = await confirmAction(this.plugin.app, 'Delete entry', `Delete "${entry.label}"? This will move the file to trash.`);
      if (!confirmed) return;
      try {
        await this.plugin.app.vault.trash(entry.file, true);
        new Notice(`Deleted "${entry.label}"`);
      } catch (err) {
        new Notice(`Failed to delete: ${err}`);
      }
    });

    // Touch
    if (isTouchDevice()) {
      this.touchManager = new TouchManager(
        this.timelineRenderer.svgElement,
        this.timelineRenderer.element,
        this.plugin.app,
        this.axis,
        this.currentScale!,
      );
      this.touchManager.locked = this._locked;
      this.touchManager.attach(entriesToRender, (row) => this.layoutEngine.getRowY(row));

      this.touchManager.setSelectCallback((entry) => {
        if (entry) {
          const idx = entriesToRender.indexOf(entry);
          if (idx >= 0) this.selectionManager?.select(idx);
        } else {
          this.selectionManager?.clear();
        }
      });
      this.touchManager.setOpenCallback((entry) => {
        this.plugin.app.workspace.getLeaf(false).openFile(entry.file);
      });
      this.touchManager.setContextMenuCallback((entry, x, y) => {
        const fakeEvent = new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true });
        this.contextMenuManager?.showBarMenuForTouch(entry, fakeEvent);
      });
      this.touchManager.setEmptyContextMenuCallback((x, y) => {
        const fakeEvent = new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true });
        this.contextMenuManager?.showEmptyMenuForTouch(fakeEvent);
      });

      if (!this._locked) {
        this.touchManager.setDragCompleteCallback(async (entry, newStart, newEnd) => {
          const newOrder = this.denseToOrder(Math.round(newStart));
          const newOrderEnd = this.denseToOrder(Math.round(newEnd) - 1); // exclusive → inclusive
          await this.plugin.app.fileManager.processFrontMatter(entry.file, (fm) => {
            fm[this._orderPropName] = newOrder;
            if (this._orderEndPropName && newOrderEnd > newOrder) {
              fm[this._orderEndPropName] = newOrderEnd;
            } else if (this._orderEndPropName && newOrderEnd <= newOrder && fm[this._orderEndPropName] != null) {
              delete fm[this._orderEndPropName];
            }
          });
          setTimeout(() => this.onDataUpdated(), 200);
        });
        this.touchManager.setCreateCallback(async (startPos, endPos) => {
          const orderVal = this.denseToOrder(Math.round(startPos));
          const fm: Record<string, any> = {};
          fm[this._orderPropName] = orderVal;
          await this.createFileForView(undefined, (frontmatter) => {
            Object.assign(frontmatter, fm);
          });
        });
      }
    }
  }

  // ─── Sequence-specific entry parsing ───

  private parseSequenceEntries(
    entries: any[],
    orderPropId: BasesPropertyId | null,
    orderEndPropId: BasesPropertyId | null,
    colorPropId: BasesPropertyId | null,
    depPropName?: string,
  ): SabidurianEntry[] {
    const result: SabidurianEntry[] = [];

    for (const entry of entries) {
      const orderVal = orderPropId ? entry.getValue(orderPropId) : null;
      const orderNum = this.parseOrderValue(orderVal);
      if (orderNum == null) continue;

      const file = entry.file;
      if (!file) continue;

      // Optional end position for multi-step spans
      const orderEndVal = orderEndPropId ? entry.getValue(orderEndPropId) : null;
      const orderEndNum = this.parseOrderValue(orderEndVal);

      let startPos = orderNum;
      let endPos = orderEndNum ?? orderNum;

      // Swap if inverted
      if (endPos < startPos) {
        const tmp = endPos;
        endPos = startPos;
        startPos = tmp;
      }

      // In sequence mode, single-position entries are NOT points —
      // they render as full-column bars. "isPoint" means no end, but
      // we want a visible bar, so we set endYear = startYear + 1.
      const isSingleStep = (endPos === startPos);
      const effectiveEndPos = isSingleStep ? startPos + 1 : endPos + 1;

      // Color
      const colorVal = colorPropId ? entry.getValue(colorPropId) : null;
      const colorStr = colorVal ? colorVal.toString() : '';
      const color = getColorForValue(colorStr);

      // Properties
      const properties: Record<string, string> = {};
      if (this.allProperties) {
        for (const propId of this.allProperties) {
          const val = entry.getValue(propId);
          if (val) {
            const name = this.config.getDisplayName(propId);
            properties[name] = val.toString();
          }
        }
      }

      // Dependencies
      const depVal = depPropName ? entry.getValue(depPropName) : null;
      const dependencies = this.resolveDependencies(depVal);

      // Per-note lock
      const lockedPropName = this.plugin.settings.lockedProperty || 'locked';
      const lockedVal = entry.getValue(lockedPropName as any);
      const locked = lockedVal === true || lockedVal === 'true' || String(lockedVal) === 'true';

      result.push({
        file,
        label: file.basename,
        start: { year: startPos, month: 1, day: 1 } as any, // Placeholder SabidurianDate
        end: { year: effectiveEndPos, month: 1, day: 1 } as any,
        startYear: startPos,
        endYear: effectiveEndPos,
        isPoint: false, // Always render as bars in sequence mode
        isOngoing: false,
        locked,
        color,
        colorValue: colorStr,
        row: 0,
        x: 0,
        width: 0,
        dependencies,
        properties,
      });
    }

    return result;
  }

  private parseOrderValue(val: any): number | null {
    if (val == null) return null;
    const num = typeof val === 'number' ? val : parseFloat(String(val));
    if (isNaN(num)) return null;
    return num;
  }

  private resolveDependencies(val: any): string[] {
    if (!val) return [];
    const items: string[] = Array.isArray(val) ? val.map(String) : [String(val)];
    const paths: string[] = [];
    for (const item of items) {
      const match = item.match(/^\[\[(.+?)\]\]$/);
      const noteName = match ? match[1] : item.trim();
      if (!noteName) continue;
      const file = this.plugin.app.metadataCache.getFirstLinkpathDest(noteName, '');
      if (file) paths.push(file.path);
    }
    return paths;
  }

  private detectCycles(entries: SabidurianEntry[]): void {
    const graph = new Map<string, string[]>();
    for (const entry of entries) {
      graph.set(entry.file.path, entry.dependencies);
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();
    let hasCycle = false;

    const dfs = (node: string): void => {
      if (inStack.has(node)) { hasCycle = true; return; }
      if (visited.has(node)) return;
      visited.add(node);
      inStack.add(node);
      for (const dep of graph.get(node) ?? []) {
        dfs(dep);
        if (hasCycle) return;
      }
      inStack.delete(node);
    };

    for (const path of graph.keys()) {
      dfs(path);
      if (hasCycle) break;
    }

    if (hasCycle) {
      new Notice('Time & Line: Circular dependency detected in blocked-by chain!', 8000);
    }
  }

  // ─── UI helpers ───

  private toggleGroup(groupName: string): void {
    if (this.collapsedGroups.has(groupName)) {
      this.collapsedGroups.delete(groupName);
    } else {
      this.collapsedGroups.add(groupName);
    }
    this.config.set('collapsedGroups', Array.from(this.collapsedGroups));
    this.onDataUpdated();
  }

  private getTableColumns(
    orderPropId: BasesPropertyId | null,
    orderEndPropId: BasesPropertyId | null,
  ): TableColumn[] {
    const columns: TableColumn[] = [];
    const visibleProps = this.config.getOrder?.() ?? [];
    for (const propId of visibleProps) {
      if (SYSTEM_PROP_PREFIXES.some(p => propId.startsWith(p))) continue;
      if (propId === orderPropId || propId === orderEndPropId) continue;
      const displayName = this.config.getDisplayName(propId);
      columns.push({ key: displayName, propId });
    }
    return columns;
  }

  private highlightBar(entryIndex: number | null): void {
    const existing = this.timelineRenderer?.svgElement.querySelectorAll('.sabidurian-bar-hover');
    existing?.forEach(el => el.classList.remove('sabidurian-bar-hover'));
    if (entryIndex == null || entryIndex < 0) return;
    const groups = this.timelineRenderer?.svgElement.querySelectorAll('.sabidurian-bar-group');
    if (groups && groups[entryIndex]) {
      groups[entryIndex].classList.add('sabidurian-bar-hover');
    }
  }

  /** Convert a dense axis index back to the original order value. No-op in sparse mode. */
  private denseToOrder(pos: number): number {
    if (!this._denseToSparse) return pos;
    const idx = pos - 1; // 1-based dense → 0-based array
    return idx >= 0 && idx < this._denseToSparse.length
      ? this._denseToSparse[idx]
      : pos;
  }

  private renderControls(entryCount: number): void {
    if (!this.rootEl) return;
    const controlsEl = this.rootEl.createDiv({ cls: 'sabidurian-controls' });

    controlsEl.createEl('span', {
      cls: 'sabidurian-controls-info',
      text: `${entryCount} entries`,
    });

    // No scale selector (sequence is always 1:1)
    // No Today button

    // Table toggle
    const showTableConfig = this.config.get('showTable') as boolean ?? true;
    const tableBtn = controlsEl.createEl('button', {
      cls: 'sabidurian-today-btn sabidurian-table-toggle-btn',
      text: showTableConfig ? 'Hide Table' : 'Show Table',
    });
    tableBtn.addEventListener('click', () => {
      this.config.set('showTable', !showTableConfig);
      this.onDataUpdated();
    });

    // Arrows toggle
    const showArrows = this.config.get('showArrows') as boolean ?? true;
    const arrowsBtn = controlsEl.createEl('button', {
      cls: 'sabidurian-today-btn sabidurian-arrows-toggle-btn',
      text: showArrows ? 'Hide Arrows' : 'Show Arrows',
    });
    arrowsBtn.addEventListener('click', () => {
      this.config.set('showArrows', !showArrows);
      this.onDataUpdated();
    });

    // Dense toggle
    const denseMode = this.config.get('denseMode') as boolean ?? false;
    const denseBtn = controlsEl.createEl('button', {
      cls: `sabidurian-today-btn sabidurian-dense-btn${denseMode ? ' sabidurian-dense-active' : ''}`,
      text: denseMode ? 'Sparse' : 'Dense',
    });
    denseBtn.addEventListener('click', () => {
      this.config.set('denseMode', !denseMode);
      this.onDataUpdated();
    });

    // Lock toggle
    const lockBtn = controlsEl.createEl('button', {
      cls: `sabidurian-today-btn sabidurian-lock-btn${this._locked ? ' sabidurian-lock-active' : ''}`,
    });
    const lockIconSpan = lockBtn.createSpan({ cls: 'sabidurian-lock-icon' });
    setIcon(lockIconSpan, this._locked ? 'lock' : 'unlock');
    lockBtn.createSpan({ text: this._locked ? 'Locked' : 'Lock' });
    lockBtn.addEventListener('click', () => {
      const currentLock = this.config.get('locked') as boolean ?? false;
      this.config.set('locked', !currentLock);
      this.onDataUpdated();
    });
  }

  private renderSkeleton(): void {
    this.scrollEl
      .querySelectorAll(':scope > .sabidurian-container')
      .forEach((el) => el.remove());
    this.rootEl = this.scrollEl.createDiv({ cls: 'sabidurian-container sabidurian-sequence-container' });
    const skeleton = this.rootEl.createDiv({ cls: 'sabidurian-skeleton' });
    const widths = [65, 40, 80, 55, 45];
    for (const w of widths) {
      const bar = skeleton.createDiv({ cls: 'sabidurian-skeleton-bar' });
      bar.style.width = `${w}%`;
    }
  }

  private renderEmptyState(message?: string): void {
    if (!this.rootEl) return;
    const empty = this.rootEl.createDiv({ cls: 'sabidurian-empty' });
    empty.createDiv({ cls: 'sabidurian-empty-icon', text: '\u{1F522}' }); // 🔢
    empty.createEl('p', { text: message ?? 'No entries found.' });
    empty.createEl('p', {
      text: 'Add a numeric order property to your notes and configure the Order property above.',
      cls: 'sabidurian-hint',
    });
  }

  private destroyManagers(): void {
    this.dragManager?.destroy(); this.dragManager = null;
    this.arrowDragManager?.destroy(); this.arrowDragManager = null;
    this.contextMenuManager?.destroy(); this.contextMenuManager = null;
    this.keyboardManager?.destroy(); this.keyboardManager = null;
    this.selectionManager?.destroy(); this.selectionManager = null;
    this.touchManager?.destroy(); this.touchManager = null;
    this.arrowRenderer?.destroy(); this.arrowRenderer = null;
    this.groupHeaderRenderer?.destroy(); this.groupHeaderRenderer = null;
    this.barRenderer?.destroy(); this.barRenderer = null;
    this.sideTableRenderer?.destroy(); this.sideTableRenderer = null;
  }

  onunload(): void {
    this.destroyManagers();
    this.rootEl?.remove();
    this.rootEl = null;
  }
}
