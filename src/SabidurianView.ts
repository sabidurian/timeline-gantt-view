import { BasesView, Notice, QueryController, setIcon } from 'obsidian';
import type { BasesPropertyId } from 'obsidian';
import type SabidurianPlugin from './main';
import { NumericAxis } from './scale/NumericAxis';
import { TimeScale, SCALES, autoSelectScale } from './scale/TimeScale';
import { HeaderRenderer } from './renderer/HeaderRenderer';
import { TimelineRenderer } from './renderer/TimelineRenderer';
import { BarRenderer } from './renderer/BarRenderer';
import { SideTableRenderer, type TableColumn } from './renderer/SideTableRenderer';
import { LayoutEngine, ROW_HEIGHT } from './model/LayoutEngine';
import type { SabidurianEntry, SabidurianGroup } from './model/SabidurianEntry';
import { GroupHeaderRenderer } from './renderer/GroupHeaderRenderer';
import {
  parseSabidurianDate,
  sabidurianDateToYear,
  formatSabidurianDate,
  type SabidurianDate,
} from './utils/dateUtils';
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
import { MeasureManager } from './interaction/MeasureManager';
import { MarkerRenderer } from './renderer/MarkerRenderer';
import { confirmAction } from './utils/confirmModal';

// Import all scale registrations
import './scale/scales/index';

const VIEW_PADDING_RATIO = 0.1;
const MIN_TIMELINE_HEIGHT = 200;
/** Entry count above which viewport culling kicks in. */
const CULLING_THRESHOLD = 150;

/** Property ID prefixes for system/file properties we never show in the table. */
const SYSTEM_PROP_PREFIXES = ['file.', 'formula.'];

export class SabidurianView extends BasesView {
  type = 'sabidurian';

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
  private measureManager: MeasureManager | null = null;
  private markerRenderer: MarkerRenderer | null = null;
  private layoutEngine: LayoutEngine = new LayoutEngine();

  // Debounced re-render for rapid frontmatter changes (drag, touch)
  private debouncedRender = debounce(() => this.onDataUpdated(), 16);

  // Axis & scale
  private axis: NumericAxis = new NumericAxis(2025, 2026, 800);
  private currentScale: TimeScale | null = null;

  // Parsed entries kept for hover sync
  private currentEntries: SabidurianEntry[] = [];
  private currentGroups: SabidurianGroup[] = [];

  // Collapsed group state (persisted in config)
  private collapsedGroups: Set<string> = new Set();

  // ── Lock state (prevents drag/resize/create) ──
  private _locked = false;

  // ── Viewport culling (Phase 11) ──
  private viewportCuller: ViewportCuller | null = null;
  /** All entries after layout (row >= 0), before viewport filtering. */
  private allVisibleEntries: SabidurianEntry[] = [];
  /** Whether culling is active for the current dataset. */
  private cullingActive = false;
  private lastViewportBounds: ViewportBounds | null = null;
  /** Debounced scroll handler for viewport-based re-render. */
  private debouncedViewportRender = debounce(() => this.renderVisibleBars(), 0);
  /** Cached config references needed by renderVisibleBars. */
  private _showArrows = true;
  private _isGrouped = false;
  private _startPropName = 'start-date';
  private _endPropName = 'end-date';

  constructor(controller: QueryController, scrollEl: HTMLElement, plugin: SabidurianPlugin) {
    super(controller);
    this.scrollEl = scrollEl;
    this.plugin = plugin;
    // Show skeleton until first data arrives
    this.renderSkeleton();
  }

  onDataUpdated(): void {
    // Preserve scroll position across re-renders
    const prevScrollLeft = this.timelineRenderer?.element.scrollLeft ?? 0;
    const prevScrollTop = this.timelineRenderer?.element.scrollTop ?? 0;

    // Clean up
    this.dragManager?.destroy();
    this.dragManager = null;
    this.arrowDragManager?.destroy();
    this.arrowDragManager = null;
    this.contextMenuManager?.destroy();
    this.contextMenuManager = null;
    this.keyboardManager?.destroy();
    this.keyboardManager = null;
    this.selectionManager?.destroy();
    this.selectionManager = null;
    this.touchManager?.destroy();
    this.touchManager = null;
    this.measureManager?.destroy();
    this.measureManager = null;
    this.markerRenderer?.destroy();
    this.markerRenderer = null;
    this.arrowRenderer?.destroy();
    this.arrowRenderer = null;
    this.groupHeaderRenderer?.destroy();
    this.groupHeaderRenderer = null;
    this.barRenderer?.destroy();
    this.barRenderer = null;
    this.sideTableRenderer?.destroy();
    this.sideTableRenderer = null;
    if (this.rootEl) {
      this.rootEl.remove();
    }
    this.rootEl = this.scrollEl.createDiv({ cls: 'sabidurian-container' });

    const entries = this.data?.data ?? [];
    if (entries.length === 0) {
      this.renderEmptyState();
      return;
    }

    // Read config
    const startPropId = this.config.getAsPropertyId('startDateProp');
    const endPropId = this.config.getAsPropertyId('endDateProp');
    const colorPropId = this.config.getAsPropertyId('colorProp');
    const earliestStartPropId = this.config.getAsPropertyId('earliestStartProp');
    const latestEndPropId = this.config.getAsPropertyId('latestEndProp');

    // Derive frontmatter property names from configured Bases property IDs
    const startPropRaw = this.config.get('startDateProp') as string | undefined;
    const endPropRaw = this.config.get('endDateProp') as string | undefined;
    this._startPropName = startPropRaw ? startPropRaw.replace(/^note\./, '') : 'start-date';
    this._endPropName = endPropRaw ? endPropRaw.replace(/^note\./, '') : 'end-date';

    // Dependency property: view config > plugin setting > default
    const depPropRaw = this.config.get('dependencyProp') as string | undefined;
    const depPropName = depPropRaw?.trim() || this.plugin.settings.dependencyProperty || 'blocked-by';

    // BCE toggle
    const enableBCE = this.config.get('enableBCE') as boolean ?? true;

    // ── Detect groups ──
    const groupedData = this.data?.groupedData ?? [];
    const isGrouped = groupedData.length > 1 ||
      (groupedData.length === 1 && groupedData[0].hasKey());

    // Restore collapsed state from config
    const savedCollapsed = this.config.get('collapsedGroups') as string[] | undefined;
    if (savedCollapsed) {
      this.collapsedGroups = new Set(savedCollapsed);
    }

    // Parse entries — grouped or ungrouped
    resetColorCache();
    let sabidurianEntries: SabidurianEntry[];
    let sabidurianGroups: SabidurianGroup[] = [];

    if (isGrouped) {
      sabidurianGroups = [];
      sabidurianEntries = [];
      for (const group of groupedData) {
        const groupName = group.hasKey() ? String(group.key) : '(No value)';
        const parsed = this.parseEntries(group.entries, startPropId, endPropId, colorPropId, depPropName, enableBCE, earliestStartPropId, latestEndPropId);
        // Tag each entry with its group
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
      sabidurianEntries = this.parseEntries(entries, startPropId, endPropId, colorPropId, depPropName, enableBCE, earliestStartPropId, latestEndPropId);
    }

    this.currentEntries = sabidurianEntries;
    this.currentGroups = sabidurianGroups;

    if (sabidurianEntries.length === 0) {
      this.renderEmptyState('No entries have valid dates. Configure the Start date property above.');
      return;
    }

    // Performance warning when entry count exceeds plugin setting
    if (sabidurianEntries.length > this.plugin.settings.maxEntries) {
      new Notice(
        `Time & Line: ${sabidurianEntries.length} entries exceed the ${this.plugin.settings.maxEntries} limit. Performance may degrade.`,
        8000,
      );
    }

    // Compute view bounds
    const { viewStart, viewEnd, range } = this.computeViewBounds(sabidurianEntries);

    // Auto-select scale first (based on range), then compute canvas width
    const containerWidth = this.rootEl.clientWidth || 800;
    const savedScaleId = this.config.get('scaleId') as string | undefined;
    this.currentScale = (savedScaleId && savedScaleId !== 'auto')
      ? (SCALES.find(s => s.id === savedScaleId) ?? autoSelectScale(range, containerWidth))
      : autoSelectScale(range, containerWidth);

    // Generate columns for the selected scale (needed before canvas width calc)
    const columns = this.currentScale.getColumnBoundaries(viewStart, viewEnd);

    // Canvas width: ensure each column gets at least ~80px so switching
    // scales always produces a visible difference in bar sizing.
    const minCanvasWidth = Math.max(containerWidth, columns.length * 80);
    const canvasWidth = Math.max(containerWidth, minCanvasWidth);
    this.axis.setView(viewStart, viewEnd, canvasWidth);
    // Lock state: per-view config OR auto-lock on mobile via plugin setting
    const configLocked = this.config.get('locked') as boolean ?? false;
    const autoLock = this.plugin.settings.lockOnMobile && isTouchDevice();
    this._locked = configLocked || autoLock;

    // Controls
    this.renderControls(sabidurianEntries.length);

    // ── Layout: side table + timeline in a horizontal flex container ──
    const bodyContainerEl = this.rootEl.createDiv({ cls: 'sabidurian-body-container' });

    // Header row (spans table + timeline)
    const headerContainerEl = bodyContainerEl.createDiv({ cls: 'sabidurian-header-container' });

    // Side table — auto-hide on narrow viewports
    const isMobile = isMobileViewport();
    const showTable = isMobile ? false : (this.config.get('showTable') as boolean ?? true);
    const savedTableWidth = this.config.get('tableWidth') as number | undefined;
    const tableColumns = this.getTableColumns(startPropId, endPropId);

    if (showTable) {
      // Table header placeholder (aligns with side table width)
      const tableHeaderSpacer = headerContainerEl.createDiv({ cls: 'sabidurian-table-header-spacer' });
      tableHeaderSpacer.style.width = `${savedTableWidth ?? 220}px`;
      tableHeaderSpacer.style.flexShrink = '0';
    }

    // Timeline header
    const timelineHeaderEl = headerContainerEl.createDiv({ cls: 'sabidurian-timeline-header-wrap' });
    this.headerRenderer = new HeaderRenderer(timelineHeaderEl);
    this.headerRenderer.render(columns, this.axis);

    // Content row (table + divider + timeline)
    const contentEl = bodyContainerEl.createDiv({ cls: 'sabidurian-content-row' });

    // Layout: assign rows (grouped or ungrouped)
    let canvasHeight: number;
    // Collect only visible entries (not in collapsed groups) for rendering
    let visibleEntries: SabidurianEntry[];

    if (isGrouped) {
      const totalHeight = this.layoutEngine.layoutGrouped(sabidurianGroups, this.axis);
      canvasHeight = Math.max(MIN_TIMELINE_HEIGHT, totalHeight);
      // Visible = entries not in collapsed groups
      visibleEntries = sabidurianEntries.filter(e => e.row >= 0);
    } else {
      const totalHeight = this.layoutEngine.layout(sabidurianEntries, this.axis);
      canvasHeight = Math.max(MIN_TIMELINE_HEIGHT, totalHeight);
      visibleEntries = sabidurianEntries;
    }

    // Side table
    if (showTable) {
      this.sideTableRenderer = new SideTableRenderer(
        contentEl,
        this.plugin.app,
        savedTableWidth,
      );

      if (isGrouped) {
        this.sideTableRenderer.renderGrouped(
          sabidurianGroups,
          sabidurianEntries,
          tableColumns,
          (row) => this.layoutEngine.getRowY(row),
        );
        this.sideTableRenderer.setGroupToggleCallback((groupName) => {
          this.toggleGroup(groupName);
        });
      } else {
        this.sideTableRenderer.render(
          sabidurianEntries,
          tableColumns,
          (row) => this.layoutEngine.getRowY(row),
        );
      }

      // Persist width changes
      this.sideTableRenderer.setWidthChangeCallback((w) => {
        this.config.set('tableWidth', w);
        // Also update header spacer
        const spacer = headerContainerEl.querySelector('.sabidurian-table-header-spacer') as HTMLElement;
        if (spacer) spacer.style.width = `${w}px`;
      });

      // Row hover sync: highlight corresponding bar
      this.sideTableRenderer.setRowHoverCallback((idx) => {
        this.highlightBar(idx);
      });
    }

    // Timeline canvas
    const showToday = this.config.get('showToday') as boolean ?? true;
    this.timelineRenderer = new TimelineRenderer(contentEl);
    this.timelineRenderer.render(columns, this.axis, canvasHeight, showToday);

    // ── Viewport culling setup (Phase 11) ──
    this._showArrows = this.config.get('showArrows') as boolean ?? true;
    this._isGrouped = isGrouped;
    this.allVisibleEntries = visibleEntries;
    this.cullingActive = visibleEntries.length > CULLING_THRESHOLD;
    this.lastViewportBounds = null;
    this.viewportCuller = new ViewportCuller((row) => this.layoutEngine.getRowY(row));

    // BarRenderer is created once; render() will be called with visible subset
    this.barRenderer = new BarRenderer(
      this.timelineRenderer.svgElement,
      this.plugin.app,
      this.rootEl,
    );
    this.barRenderer.setAxis(this.axis);
    this.barRenderer.setDatePropNames(this._startPropName, this._endPropName);

    // Configure bar property badges
    const barDisplayProps: string[] = [];
    for (const key of ['barDisplayProp1', 'barDisplayProp2', 'barDisplayProp3']) {
      const val = this.config.get(key) as string | undefined;
      if (val) {
        // Strip note. prefix from Bases property IDs
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

    // Group headers in SVG (always fully rendered — there aren't hundreds of them)
    if (isGrouped) {
      this.groupHeaderRenderer = new GroupHeaderRenderer(
        this.timelineRenderer.svgElement,
      );
      this.groupHeaderRenderer.render(sabidurianGroups, canvasWidth);
      this.groupHeaderRenderer.setToggleCallback((groupName) => {
        this.toggleGroup(groupName);
      });
    }

    // Detect dependency cycles once (operates on full set, not viewport)
    if (this._showArrows) {
      this.detectCycles(sabidurianEntries);
    }

    // ── Initial bar render (viewport-filtered if culling is active) ──
    // Uses renderVisibleBars() which also sets up all interaction managers.
    // For the initial render before scroll data is available, render all
    // entries when culling is off, or a generous initial set when culling is on.
    this.renderVisibleBars();

    // Raise the today marker above bars, group headers, and arrows
    this.timelineRenderer.raiseTodayMarker();

    // ── Scroll sync ──
    const timelineBody = this.timelineRenderer.element;

    // Horizontal: sync header with timeline
    timelineBody.addEventListener('scroll', () => {
      this.headerRenderer?.setScrollLeft(timelineBody.scrollLeft);
      // Viewport culling: schedule re-render if scrolled far enough
      if (this.cullingActive) {
        this.debouncedViewportRender();
      }
    });

    // Vertical: sync side table with timeline
    if (this.sideTableRenderer) {
      const tableBody = this.sideTableRenderer.scrollBody;

      timelineBody.addEventListener('scroll', () => {
        tableBody.scrollTop = timelineBody.scrollTop;
      });
      tableBody.addEventListener('scroll', () => {
        timelineBody.scrollTop = tableBody.scrollTop;
      });
    }

    // Restore scroll position from before re-render
    if (prevScrollLeft || prevScrollTop) {
      requestAnimationFrame(() => {
        timelineBody.scrollLeft = prevScrollLeft;
        timelineBody.scrollTop = prevScrollTop;
        this.headerRenderer?.setScrollLeft(prevScrollLeft);
        if (this.sideTableRenderer) {
          this.sideTableRenderer.scrollBody.scrollTop = prevScrollTop;
        }
        // After restoring scroll, do a viewport render with correct bounds
        if (this.cullingActive) {
          this.renderVisibleBars();
        }
      });
    }
  }

  /**
   * Render (or re-render) bars + arrows + interaction managers for the
   * entries currently visible in the scroll viewport.
   *
   * When culling is inactive (small dataset), renders all entries.
   * When culling is active, uses ViewportCuller to filter.
   *
   * This method can be called repeatedly on scroll without a full
   * onDataUpdated cycle — it only touches bars, arrows, and interactions.
   */
  private renderVisibleBars(): void {
    if (!this.timelineRenderer || !this.barRenderer || !this.rootEl) return;

    const timelineBody = this.timelineRenderer.element;

    // Determine which entries to render
    let entriesToRender: SabidurianEntry[];

    if (this.cullingActive && this.viewportCuller) {
      const bounds: ViewportBounds = {
        scrollLeft: timelineBody.scrollLeft,
        scrollTop: timelineBody.scrollTop,
        viewportWidth: timelineBody.clientWidth,
        viewportHeight: timelineBody.clientHeight,
      };

      // Skip re-render if viewport hasn't moved significantly
      if (!ViewportCuller.shouldRecull(this.lastViewportBounds, bounds)) return;
      this.lastViewportBounds = bounds;

      entriesToRender = this.viewportCuller.cull(this.allVisibleEntries, bounds);
    } else {
      entriesToRender = this.allVisibleEntries;
    }

    // ── Tear down interaction managers (they attach to bar DOM elements) ──
    this.dragManager?.destroy();
    this.dragManager = null;
    this.arrowDragManager?.destroy();
    this.arrowDragManager = null;
    this.contextMenuManager?.destroy();
    this.contextMenuManager = null;
    this.keyboardManager?.destroy();
    this.keyboardManager = null;
    this.selectionManager?.destroy();
    this.selectionManager = null;
    this.touchManager?.destroy();
    this.touchManager = null;
    this.arrowRenderer?.destroy();
    this.arrowRenderer = null;

    // ── Calendar markers (behind bars, above grid) ──
    const markers = this.plugin.settings.markers;
    if (markers && markers.length > 0) {
      if (!this.markerRenderer) {
        this.markerRenderer = new MarkerRenderer();
      }
      const svgHeight = parseFloat(this.timelineRenderer.svgElement.getAttribute('height') || '0');
      this.markerRenderer.render(
        this.timelineRenderer.svgElement,
        markers,
        this.axis,
        svgHeight,
      );
    } else {
      this.markerRenderer?.destroy();
    }

    // ── Render bars for visible entries ──
    this.barRenderer.render(entriesToRender, (row) => this.layoutEngine.getRowY(row));

    // ── Measure manager (persistent across re-renders unless destroyed) ──
    if (!this.measureManager && this.rootEl) {
      this.measureManager = new MeasureManager(
        this.timelineRenderer.svgElement,
        this.rootEl,
        this.axis,
      );
      // Click interception: measure mode consumes clicks before BarRenderer
      this.timelineRenderer.svgElement.addEventListener('click', (e) => {
        if (this.measureManager?.handleClick(e)) {
          e.stopPropagation();
          // Deactivate button highlight when measurement is complete or cleared
          if (!this.measureManager.isActive) {
            this.rootEl?.querySelector('.sabidurian-measure-btn')?.classList.remove('sabidurian-measure-active');
          }
        }
      }, true); // Capture phase — before BarRenderer's click

      // Escape keydown: let MeasureManager cancel before KeyboardManager clears selection
      this.rootEl.addEventListener('keydown', (e) => {
        if (this.measureManager?.handleKeydown(e)) {
          e.stopPropagation();
          this.rootEl?.querySelector('.sabidurian-measure-btn')?.classList.remove('sabidurian-measure-active');
        }
      }, true); // Capture phase — before KeyboardManager
    }

    // ── Dependency arrows (visible entries only) ──
    if (this._showArrows) {
      this.arrowRenderer = new ArrowRenderer(
        this.timelineRenderer.svgElement,
        this.plugin.app,
      );
      this.arrowRenderer.render(
        entriesToRender,
        (row) => this.layoutEngine.getRowY(row),
      );

      // Arrow drag-to-connect only when unlocked
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

    // ── Drag interactions (skipped when locked) ──
    if (!this._locked) {
      this.dragManager = new DragManager(
        this.timelineRenderer.svgElement,
        this.timelineRenderer.element,
        this.plugin.app,
        this.axis,
        this.currentScale!,
      );
      this.dragManager.setDatePropNames(this._startPropName, this._endPropName);
      this.dragManager.attachToBarGroups(
        entriesToRender,
        (row) => this.layoutEngine.getRowY(row),
      );
      this.dragManager.setDragCompleteCallback(() => {
        // Bases may auto-refresh, but force a re-render as fallback
        setTimeout(() => this.onDataUpdated(), 200);
      });
      this.dragManager.setCreateCallback(async (startYear, endYear) => {
        const startStr = this.yearToDateStr(startYear);
        const endStr = this.yearToDateStr(endYear);
        await this.createFileForView(undefined, (fm) => {
          fm[this._startPropName] = startStr;
          fm[this._endPropName] = endStr;
        });
      });
    }

    // ── Selection manager ──
    this.selectionManager = new SelectionManager(this.timelineRenderer.svgElement);
    this.selectionManager.attach(entriesToRender);

    // ── Context menus ──
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
    this.contextMenuManager.setCreateCallback(async (startYear, endYear) => {
      const startStr = this.yearToDateStr(startYear);
      const endStr = this.yearToDateStr(endYear);
      await this.createFileForView(undefined, (fm) => {
        fm[this._startPropName] = startStr;
        fm[this._endPropName] = endStr;
      });
    });
    this.contextMenuManager.setScrollToTodayCallback(() => {
      this.scrollToToday();
    });
    this.contextMenuManager.setChangeScaleCallback((scaleId) => {
      this.config.set('scaleId', scaleId);
      this.onDataUpdated();
    });
    this.contextMenuManager.setRefreshCallback(() => {
      setTimeout(() => this.onDataUpdated(), 200);
    });

    // ── Keyboard navigation ──
    this.keyboardManager = new KeyboardManager(
      this.rootEl,
      this.plugin.app,
      this.selectionManager,
      this.currentScale!.id,
    );
    // Keyboard nav always operates on ALL visible entries (not just viewport)
    // so arrow keys can navigate off-screen and trigger scroll.
    this.keyboardManager.attach(this.allVisibleEntries);
    this.keyboardManager.setScrollToTodayCallback(() => {
      this.scrollToToday();
    });
    this.keyboardManager.setChangeScaleCallback((scaleId) => {
      this.config.set('scaleId', scaleId);
      this.onDataUpdated();
    });
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
    this.keyboardManager.setMeasureToggleCallback(() => {
      const btn = this.rootEl?.querySelector('.sabidurian-measure-btn');
      if (this.measureManager?.isActive) {
        this.measureManager.deactivate();
        btn?.classList.remove('sabidurian-measure-active');
      } else if (this.measureManager) {
        this.measureManager.activate();
        btn?.classList.add('sabidurian-measure-active');
      }
    });

    // ── Touch interactions (mobile) ──
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
        const fakeEvent = new MouseEvent('contextmenu', {
          clientX: x, clientY: y, bubbles: true,
        });
        this.contextMenuManager?.showBarMenuForTouch(entry, fakeEvent);
      });

      this.touchManager.setEmptyContextMenuCallback((x, y) => {
        const fakeEvent = new MouseEvent('contextmenu', {
          clientX: x, clientY: y, bubbles: true,
        });
        this.contextMenuManager?.showEmptyMenuForTouch(fakeEvent);
      });

      // Drag & create callbacks only when unlocked
      if (!this._locked) {
        this.touchManager.setDragCompleteCallback(async (entry, newStart, newEnd) => {
          const startDateStr = this.yearToDateStr(newStart);
          const endDateStr = this.yearToDateStr(newEnd);
          await this.plugin.app.fileManager.processFrontMatter(entry.file, (fm) => {
            fm[this._startPropName] = startDateStr;
            if (!entry.isPoint) {
              fm[this._endPropName] = endDateStr;
            }
          });
          setTimeout(() => this.onDataUpdated(), 200);
        });

        this.touchManager.setCreateCallback(async (startYear, endYear) => {
          const startStr = this.yearToDateStr(startYear);
          const endStr = this.yearToDateStr(endYear);
          await this.createFileForView(undefined, (fm) => {
            fm[this._startPropName] = startStr;
            fm[this._endPropName] = endStr;
          });
        });
      }

      this.touchManager.setScaleChangeCallback((direction) => {
        const currentIdx = SCALES.findIndex(s => s.id === this.currentScale?.id);
        const newIdx = direction === 'in'
          ? Math.max(0, currentIdx - 1)
          : Math.min(SCALES.length - 1, currentIdx + 1);
        if (newIdx !== currentIdx) {
          this.config.set('scaleId', SCALES[newIdx].id);
          this.debouncedRender();
        }
      });
    }

    // Ensure today marker stays on top after bars are re-rendered
    this.timelineRenderer.raiseTodayMarker();
  }

  /** Scroll the timeline to today's position. */
  private scrollToToday(): void {
    const now = new Date();
    const y = now.getFullYear();
    const start = new Date(y, 0, 1).getTime();
    const end = new Date(y + 1, 0, 1).getTime();
    const todayFrac = y + (now.getTime() - start) / (end - start);
    this.timelineRenderer?.scrollToYear(this.axis, todayFrac);
  }

  /** Toggle a group's collapsed state and re-render. */
  private toggleGroup(groupName: string): void {
    if (this.collapsedGroups.has(groupName)) {
      this.collapsedGroups.delete(groupName);
    } else {
      this.collapsedGroups.add(groupName);
    }
    // Persist
    this.config.set('collapsedGroups', Array.from(this.collapsedGroups));
    this.onDataUpdated();
  }

  /** Build table column definitions from visible properties. */
  private getTableColumns(
    startPropId: BasesPropertyId | null,
    endPropId: BasesPropertyId | null,
  ): TableColumn[] {
    const columns: TableColumn[] = [];
    const visibleProps = this.config.getOrder?.() ?? [];

    for (const propId of visibleProps) {
      // Skip system properties
      if (SYSTEM_PROP_PREFIXES.some(p => propId.startsWith(p))) continue;
      // Skip start/end date (redundant with the bars)
      if (propId === startPropId || propId === endPropId) continue;

      const displayName = this.config.getDisplayName(propId);
      columns.push({ key: displayName, propId });
    }

    return columns;
  }

  /** Highlight a bar by entry index (for hover sync from side table). */
  private highlightBar(entryIndex: number | null): void {
    // Remove existing highlights
    const existing = this.timelineRenderer?.svgElement.querySelectorAll('.sabidurian-bar-hover');
    existing?.forEach(el => el.classList.remove('sabidurian-bar-hover'));

    if (entryIndex == null || entryIndex < 0) return;

    const groups = this.timelineRenderer?.svgElement.querySelectorAll('.sabidurian-bar-group');
    if (groups && groups[entryIndex]) {
      groups[entryIndex].classList.add('sabidurian-bar-hover');
    }
  }

  private parseEntries(
    entries: any[],
    startPropId: BasesPropertyId | null,
    endPropId: BasesPropertyId | null,
    colorPropId: BasesPropertyId | null,
    depPropName?: string,
    enableBCE = true,
    earliestStartPropId?: BasesPropertyId | null,
    latestEndPropId?: BasesPropertyId | null,
  ): SabidurianEntry[] {
    const result: SabidurianEntry[] = [];

    for (const entry of entries) {
      const startVal = startPropId ? entry.getValue(startPropId) : null;
      let startDate = parseSabidurianDate(startVal);

      const endVal = endPropId ? entry.getValue(endPropId) : null;
      let endDate = parseSabidurianDate(endVal);

      // Parse fuzzy/uncertainty dates early so we can fall back to them
      let earliestStart: SabidurianDate | undefined;
      let latestEnd: SabidurianDate | undefined;
      let earliestStartYear: number | undefined;
      let latestEndYear: number | undefined;

      if (earliestStartPropId) {
        const esVal = entry.getValue(earliestStartPropId);
        const esParsed = parseSabidurianDate(esVal);
        if (esParsed) {
          earliestStart = esParsed;
          earliestStartYear = sabidurianDateToYear(esParsed);
        }
      }

      if (latestEndPropId) {
        const leVal = entry.getValue(latestEndPropId);
        const leParsed = parseSabidurianDate(leVal);
        if (leParsed) {
          latestEnd = leParsed;
          latestEndYear = sabidurianDateToYear(leParsed);
        }
      }

      // Fuzzy-only fallback: if no primary dates, use fuzzy dates as the range
      let fuzzyOnly = false;
      if (!startDate && earliestStart) {
        startDate = earliestStart;
        fuzzyOnly = true;
      }
      if (!endDate && latestEnd) {
        endDate = latestEnd;
      }

      // Still no start date after fallback — skip
      if (!startDate) continue;

      const file = entry.file;
      if (!file) continue;

      let startYear = sabidurianDateToYear(startDate);
      let endYear = endDate ? sabidurianDateToYear(endDate) : startYear;

      // Skip BCE entries when BCE mode is disabled
      if (!enableBCE && (startYear < 1 || endYear < 1)) continue;

      // Handle inverted ranges: swap so start < end
      let effectiveStart = startDate;
      let effectiveEnd = endDate;
      if (endDate && endYear < startYear) {
        const tmp = endYear;
        endYear = startYear;
        startYear = tmp;
        effectiveStart = endDate;
        effectiveEnd = startDate;
      }

      // Detect ongoing events: has start but no end date
      let isOngoing = false;
      if (!endDate && startDate) {
        const now = new Date();
        const currentYear = now.getFullYear() + (now.getMonth() / 12) + (now.getDate() / 365);
        isOngoing = true;
        endYear = currentYear;
      }

      const isPoint = !isOngoing && (!endDate || Math.abs(endYear - startYear) < 0.001);

      // Color
      const colorVal = colorPropId ? entry.getValue(colorPropId) : null;
      const colorStr = colorVal ? colorVal.toString() : '';
      const color = getColorForValue(colorStr);

      // Gather extra properties for tooltip + table
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

      // Parse dependencies (wikilinks from configured dependency property)
      const depVal = depPropName ? entry.getValue(depPropName) : null;
      const dependencies = this.resolveDependencies(depVal);

      // Clamp fuzzy dates relative to effective start/end
      if (earliestStartYear !== undefined && earliestStartYear > startYear) {
        earliestStartYear = startYear;
      }
      if (latestEndYear !== undefined && latestEndYear < endYear) {
        latestEndYear = endYear;
      }

      // Per-note lock
      const lockedPropName = this.plugin.settings.lockedProperty || 'locked';
      const lockedVal = entry.getValue(lockedPropName as any);
      const locked = lockedVal === true || lockedVal === 'true' || String(lockedVal) === 'true';

      result.push({
        file,
        label: file.basename,
        start: effectiveStart,
        end: effectiveEnd,
        startYear,
        endYear,
        isPoint,
        isOngoing,
        locked,
        fuzzyOnly,
        earliestStart,
        latestEnd,
        earliestStartYear,
        latestEndYear,
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

  /**
   * Resolve a `blocked-by` frontmatter value into an array of file paths.
   * Accepts: array of wikilinks like ["[[Task A]]"], single wikilink, or string.
   */
  private resolveDependencies(val: any): string[] {
    if (!val) return [];

    const items: string[] = Array.isArray(val) ? val.map(String) : [String(val)];
    const paths: string[] = [];

    for (const item of items) {
      // Extract note name from wikilink: "[[Some Note]]" → "Some Note"
      const match = item.match(/^\[\[(.+?)\]\]$/);
      const noteName = match ? match[1] : item.trim();
      if (!noteName) continue;

      // Resolve via metadataCache
      const file = this.plugin.app.metadataCache.getFirstLinkpathDest(noteName, '');
      if (file) {
        paths.push(file.path);
      }
    }

    return paths;
  }

  /**
   * Detect cycles in the dependency graph and warn via Notice.
   * Simple DFS-based cycle detection.
   */
  private detectCycles(entries: SabidurianEntry[]): void {
    const graph = new Map<string, string[]>();
    for (const entry of entries) {
      graph.set(entry.file.path, entry.dependencies);
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();
    let hasCycle = false;

    const dfs = (node: string): void => {
      if (inStack.has(node)) {
        hasCycle = true;
        return;
      }
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
      new Notice(
        'Time & Line: Circular dependency detected in blocked-by chain!',
        8000,
      );
    }
  }

  private computeViewBounds(entries: SabidurianEntry[]): {
    viewStart: number;
    viewEnd: number;
    range: number;
  } {
    let minYear = Infinity;
    let maxYear = -Infinity;

    for (const e of entries) {
      const effStart = e.earliestStartYear ?? e.startYear;
      const effEnd = e.latestEndYear ?? e.endYear;
      if (effStart < minYear) minYear = effStart;
      if (e.startYear > maxYear) maxYear = e.startYear;
      if (effEnd < minYear) minYear = effEnd;
      if (effEnd > maxYear) maxYear = effEnd;
    }

    const range = maxYear - minYear || 1;
    const padding = range * VIEW_PADDING_RATIO;
    return {
      viewStart: minYear - padding,
      viewEnd: maxYear + padding,
      range,
    };
  }

  private renderControls(entryCount: number): void {
    if (!this.rootEl) return;

    const controlsEl = this.rootEl.createDiv({ cls: 'sabidurian-controls' });

    // Entry count
    controlsEl.createEl('span', {
      cls: 'sabidurian-controls-info',
      text: `${entryCount} entries`,
    });

    // Scale selector
    const scaleSelect = controlsEl.createEl('select', { cls: 'sabidurian-scale-select' });
    for (const scale of SCALES) {
      const opt = scaleSelect.createEl('option', { value: scale.id, text: scale.label });
      if (this.currentScale && scale.id === this.currentScale.id) {
        opt.selected = true;
      }
    }
    scaleSelect.addEventListener('change', () => {
      this.config.set('scaleId', scaleSelect.value);
      this.onDataUpdated();
    });

    // Today button
    const todayBtn = controlsEl.createEl('button', {
      cls: 'sabidurian-today-btn',
      text: 'Today',
    });
    todayBtn.addEventListener('click', () => {
      this.scrollToToday();
    });

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

    // Measure button
    const measureBtn = controlsEl.createEl('button', {
      cls: 'sabidurian-today-btn sabidurian-measure-btn',
      attr: { 'aria-label': 'Measure distance' },
    });
    const measureIconSpan = measureBtn.createSpan({ cls: 'sabidurian-lock-icon' });
    setIcon(measureIconSpan, 'ruler');
    measureBtn.createSpan({ text: 'Measure' });
    measureBtn.addEventListener('click', () => {
      if (this.measureManager?.isActive) {
        this.measureManager.deactivate();
        measureBtn.classList.remove('sabidurian-measure-active');
      } else if (this.measureManager) {
        this.measureManager.activate();
        measureBtn.classList.add('sabidurian-measure-active');
      }
    });
  }

  private renderSkeleton(): void {
    this.rootEl = this.scrollEl.createDiv({ cls: 'sabidurian-container' });
    const skeleton = this.rootEl.createDiv({ cls: 'sabidurian-skeleton' });
    // 5 shimmer bars at staggered widths
    const widths = [65, 40, 80, 55, 45];
    for (const w of widths) {
      const bar = skeleton.createDiv({ cls: 'sabidurian-skeleton-bar' });
      bar.style.width = `${w}%`;
    }
  }

  private renderEmptyState(message?: string): void {
    if (!this.rootEl) return;
    const empty = this.rootEl.createDiv({ cls: 'sabidurian-empty' });
    // Calendar icon as visual anchor
    empty.createDiv({ cls: 'sabidurian-empty-icon', text: '\u{1F4C5}' });
    empty.createEl('p', { text: message ?? 'No entries found.' });
    empty.createEl('p', {
      text: 'Add date properties to your notes and configure the Start date option above.',
      cls: 'sabidurian-hint',
    });
  }

  /**
   * Convert a fractional year to a YAML-friendly date string.
   * Mirrors DragManager.yearToDateString for the create callback.
   */
  private yearToDateStr(fractionalYear: number): string | number {
    if (fractionalYear < 1) {
      // BCE: return plain number so YAML writes e.g. -500 (not '"-500"')
      return Math.round(fractionalYear);
    }
    const year = Math.floor(fractionalYear);
    const frac = fractionalYear - year;
    const yStr = String(year).padStart(4, '0');
    if (frac < 0.001) return yStr;

    // Convert fractional year to month/day
    // Use Date.UTC to avoid JS treating years 0-99 as 1900-1999
    const dayOfYear = Math.round(frac * 365);
    const date = new Date(Date.UTC(2000, 0, 1 + dayOfYear));
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${yStr}-${m}-${d}`;
  }

  onunload(): void {
    this.dragManager?.destroy();
    this.dragManager = null;
    this.arrowDragManager?.destroy();
    this.arrowDragManager = null;
    this.contextMenuManager?.destroy();
    this.contextMenuManager = null;
    this.keyboardManager?.destroy();
    this.keyboardManager = null;
    this.selectionManager?.destroy();
    this.selectionManager = null;
    this.touchManager?.destroy();
    this.touchManager = null;
    this.arrowRenderer?.destroy();
    this.arrowRenderer = null;
    this.groupHeaderRenderer?.destroy();
    this.groupHeaderRenderer = null;
    this.barRenderer?.destroy();
    this.barRenderer = null;
    this.sideTableRenderer?.destroy();
    this.sideTableRenderer = null;
    this.rootEl?.remove();
    this.rootEl = null;
  }
}
