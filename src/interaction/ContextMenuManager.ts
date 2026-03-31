/**
 * ContextMenuManager — Right-click context menus for bars and empty canvas areas.
 *
 * Bar menu: Open, Open in new tab, Edit dates, Duplicate, Delete,
 *           Add dependency, Remove dependencies, Change color
 * Empty area menu: Create entry, Jump to today, Change scale
 */

import { Menu, Notice, FuzzySuggestModal } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { confirmAction } from '../utils/confirmModal';
import type { SabidurianEntry } from '../model/SabidurianEntry';
import { NumericAxis } from '../scale/NumericAxis';
import { TimeScale, SCALES } from '../scale/TimeScale';
import { formatSabidurianDate } from '../utils/dateUtils';

/** Fuzzy picker for selecting a dependency target. */
class DependencyPicker extends FuzzySuggestModal<SabidurianEntry> {
  private target: SabidurianEntry;
  private items: SabidurianEntry[];
  private onDone: () => void;

  constructor(app: App, target: SabidurianEntry, items: SabidurianEntry[], onDone: () => void) {
    super(app);
    this.target = target;
    this.items = items;
    this.onDone = onDone;
    this.setPlaceholder(`Add dependency to "${target.label}"…`);
  }

  getItems(): SabidurianEntry[] {
    return this.items;
  }

  getItemText(item: SabidurianEntry): string {
    return item.label;
  }

  async onChooseItem(blocker: SabidurianEntry): Promise<void> {
    const wikilink = `[[${blocker.file.basename}]]`;
    await this.app.fileManager.processFrontMatter(this.target.file, (fm) => {
      const existing = fm['blocked-by'];
      if (Array.isArray(existing)) {
        if (!existing.includes(wikilink)) {
          existing.push(wikilink);
        }
      } else if (existing) {
        fm['blocked-by'] = [String(existing), wikilink];
      } else {
        fm['blocked-by'] = [wikilink];
      }
    });
    new Notice(`Added dependency: "${this.target.label}" blocked by "${blocker.label}"`);
    this.onDone();
  }
}

type CreateCallback = (startYear: number, endYear: number) => void;
type ScrollToTodayCallback = () => void;
type ChangeScaleCallback = (scaleId: string) => void;
type RefreshCallback = () => void;

export class ContextMenuManager {
  private app: App;
  private svg: SVGSVGElement;
  private axis: NumericAxis;
  private scale: TimeScale;
  private entries: SabidurianEntry[] = [];
  private getRowY: (row: number) => number = () => 0;

  // Callbacks
  private onCreateEntry: CreateCallback | null = null;
  private onScrollToToday: ScrollToTodayCallback | null = null;
  private onChangeScale: ChangeScaleCallback | null = null;
  private onRefresh: RefreshCallback | null = null;

  /** Frontmatter property name for per-note locking. */
  lockedProperty = 'locked';

  constructor(
    svg: SVGSVGElement,
    app: App,
    axis: NumericAxis,
    scale: TimeScale,
  ) {
    this.svg = svg;
    this.app = app;
    this.axis = axis;
    this.scale = scale;
  }

  attach(
    entries: SabidurianEntry[],
    getRowY: (row: number) => number,
  ): void {
    this.entries = entries;
    this.getRowY = getRowY;

    // Bar context menus
    const groups = this.svg.querySelectorAll('.sabidurian-bar-group');
    groups.forEach((group, idx) => {
      if (idx >= entries.length) return;
      group.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showBarMenu(entries[idx], e as MouseEvent);
      });
    });

    // Empty area context menu
    this.svg.addEventListener('contextmenu', (e) => {
      if ((e.target as Element).closest('.sabidurian-bar-group')) return;
      if ((e.target as Element).closest('.sabidurian-group-header')) return;
      if ((e.target as Element).closest('.sabidurian-arrow-group')) return;
      e.preventDefault();
      this.showEmptyAreaMenu(e);
    });
  }

  // ── Bar context menu ──

  private showBarMenu(entry: SabidurianEntry, e: MouseEvent): void {
    const menu = new Menu();

    // Open
    menu.addItem((item) =>
      item.setTitle('Open')
        .setIcon('file-text')
        .onClick(() => {
          this.app.workspace.getLeaf(false).openFile(entry.file);
        }),
    );

    // Open in new tab
    menu.addItem((item) =>
      item.setTitle('Open in new tab')
        .setIcon('file-plus')
        .onClick(() => {
          this.app.workspace.getLeaf('tab').openFile(entry.file);
        }),
    );

    // Open to the right
    menu.addItem((item) =>
      item.setTitle('Open to the right')
        .setIcon('separator-vertical')
        .onClick(() => {
          this.app.workspace.getLeaf('split', 'vertical').openFile(entry.file);
        }),
    );

    menu.addSeparator();

    // Edit dates
    menu.addItem((item) =>
      item.setTitle('Edit dates…')
        .setIcon('calendar')
        .onClick(() => {
          this.editDates(entry);
        }),
    );

    // Duplicate
    menu.addItem((item) =>
      item.setTitle('Duplicate')
        .setIcon('copy')
        .onClick(() => {
          this.duplicateEntry(entry);
        }),
    );

    // Delete
    menu.addItem((item) =>
      item.setTitle('Delete')
        .setIcon('trash-2')
        .onClick(() => {
          this.deleteEntry(entry);
        }),
    );

    menu.addSeparator();

    // Add dependency
    menu.addItem((item) =>
      item.setTitle('Add dependency…')
        .setIcon('arrow-right')
        .onClick(() => {
          this.addDependency(entry);
        }),
    );

    // Remove dependencies (only if has any)
    if (entry.dependencies.length > 0) {
      menu.addItem((item) =>
        item.setTitle('Remove all dependencies')
          .setIcon('x-circle')
          .onClick(() => {
            this.removeAllDependencies(entry);
          }),
      );
    }

    menu.addSeparator();

    // Toggle per-note lock
    menu.addItem((item) =>
      item.setTitle(entry.locked ? 'Unlock' : 'Lock')
        .setIcon(entry.locked ? 'unlock' : 'lock')
        .onClick(async () => {
          const lockedProp = this.lockedProperty || 'locked';
          await this.app.fileManager.processFrontMatter(entry.file, (fm) => {
            if (entry.locked) {
              delete fm[lockedProp];
            } else {
              fm[lockedProp] = true;
            }
          });
          this.onRefresh?.();
        }),
    );

    // Change color
    menu.addItem((item) =>
      item.setTitle('Change color…')
        .setIcon('palette')
        .onClick(() => {
          this.changeColor(entry);
        }),
    );

    menu.showAtMouseEvent(e);
  }

  // ── Empty area context menu ──

  private showEmptyAreaMenu(e: MouseEvent): void {
    const menu = new Menu();

    // Create entry at click position
    menu.addItem((item) =>
      item.setTitle('Create entry here')
        .setIcon('plus')
        .onClick(() => {
          const svgRect = this.svg.getBoundingClientRect();
          const localX = e.clientX - svgRect.left + this.svg.parentElement!.scrollLeft;
          const clickYear = this.axis.pixelToYear(localX);
          // Create a small default range around click point
          const unitDuration = this.scale.unitDurationYears;
          this.onCreateEntry?.(clickYear, clickYear + unitDuration);
        }),
    );

    menu.addSeparator();

    // Jump to today
    menu.addItem((item) =>
      item.setTitle('Jump to today')
        .setIcon('calendar')
        .onClick(() => {
          this.onScrollToToday?.();
        }),
    );

    menu.addSeparator();

    // Change scale submenu
    const scaleSubmenu = menu.addItem((item) =>
      item.setTitle('Change scale')
        .setIcon('zoom-in'),
    );
    for (const scale of SCALES) {
      menu.addItem((item) =>
        item.setTitle(`  ${scale.label}${scale.id === this.scale.id ? ' ✓' : ''}`)
          .onClick(() => {
            this.onChangeScale?.(scale.id);
          }),
      );
    }

    menu.showAtMouseEvent(e);
  }

  // ── Actions ──

  private async editDates(entry: SabidurianEntry): Promise<void> {
    // Read current dates and present a simple prompt-based editor
    const startStr = formatSabidurianDate(entry.start);
    const endStr = entry.end ? formatSabidurianDate(entry.end) : '';

    // Use Obsidian's built-in prompt — there's no native multi-field dialog,
    // so we'll open the file for editing and show a notice with current dates
    new Notice(
      `${entry.label}\nStart: ${startStr}\nEnd: ${endStr || '(none)'}\n\nOpen the note to edit dates directly.`,
      6000,
    );
    this.app.workspace.getLeaf(false).openFile(entry.file);
  }

  private async duplicateEntry(entry: SabidurianEntry): Promise<void> {
    try {
      const originalContent = await this.app.vault.read(entry.file);
      const folder = entry.file.parent?.path ?? '';
      const baseName = entry.file.basename;

      // Find a unique name
      let copyNum = 1;
      let newName = `${baseName} (copy)`;
      while (this.app.vault.getAbstractFileByPath(`${folder}/${newName}.md`)) {
        copyNum++;
        newName = `${baseName} (copy ${copyNum})`;
      }

      const newPath = folder ? `${folder}/${newName}.md` : `${newName}.md`;
      await this.app.vault.create(newPath, originalContent);
      new Notice(`Duplicated "${baseName}" → "${newName}"`);
    } catch (err) {
      new Notice(`Failed to duplicate: ${err}`);
    }
  }

  private async deleteEntry(entry: SabidurianEntry): Promise<void> {
    // Confirm before deleting
    const confirmed = await confirmAction(this.app, 'Delete entry', `Delete "${entry.label}"? This will move the file to trash.`);
    if (!confirmed) return;

    try {
      await this.app.vault.trash(entry.file, true);
      new Notice(`Deleted "${entry.label}"`);
    } catch (err) {
      new Notice(`Failed to delete: ${err}`);
    }
  }

  private addDependency(entry: SabidurianEntry): void {
    const otherEntries = this.entries.filter(e => e.file.path !== entry.file.path);
    if (otherEntries.length === 0) {
      new Notice('No other entries to create a dependency with.');
      return;
    }

    new DependencyPicker(this.app, entry, otherEntries, () => {
      this.onRefresh?.();
    }).open();
  }

  private async removeAllDependencies(entry: SabidurianEntry): Promise<void> {
    await this.app.fileManager.processFrontMatter(entry.file, (fm) => {
      delete fm['blocked-by'];
    });
    new Notice(`Removed all dependencies from "${entry.label}"`);
    this.onRefresh?.();
  }

  private async changeColor(entry: SabidurianEntry): Promise<void> {
    // Show a simple notice — color is determined by the "color by" property,
    // so we open the note for editing
    new Notice(
      `Color is determined by the "Color by" property in view options.\nOpen the note to change its value.`,
      5000,
    );
    this.app.workspace.getLeaf(false).openFile(entry.file);
  }

  // ── Public methods for touch-triggered menus ──

  /** Show bar context menu at a specific position (for touch long-press). */
  showBarMenuForTouch(entry: SabidurianEntry, e: MouseEvent): void {
    this.showBarMenu(entry, e);
  }

  /** Show empty-area context menu at a specific position (for touch long-press). */
  showEmptyMenuForTouch(e: MouseEvent): void {
    this.showEmptyAreaMenu(e);
  }

  // ── Callback setters ──

  setCreateCallback(cb: CreateCallback): void {
    this.onCreateEntry = cb;
  }

  setScrollToTodayCallback(cb: ScrollToTodayCallback): void {
    this.onScrollToToday = cb;
  }

  setChangeScaleCallback(cb: ChangeScaleCallback): void {
    this.onChangeScale = cb;
  }

  setRefreshCallback(cb: RefreshCallback): void {
    this.onRefresh = cb;
  }

  destroy(): void {
    this.onCreateEntry = null;
    this.onScrollToToday = null;
    this.onChangeScale = null;
    this.onRefresh = null;
  }
}
