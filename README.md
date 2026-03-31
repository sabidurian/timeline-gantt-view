

# Time & Line

**A set of Gantt chart and timeline views for Obsidian Bases.**

Time & Line adds two powerful visual views to [Obsidian Bases](https://obsidian.md): a date-driven **Timeline View** and an order-driven **Sequence View**. Together they let you visualize, plan, and interact with your notes as timelines, Gantt charts, process flows, and ranked sequences, all without leaving your vault.

Both views were inspired by **Aeon Timeline** and **Notion's timeline features**, attempting to implement the best of both: Aeon's deep temporal modeling (BCE dates, fuzzy date ranges, measurement tools, dependency logic) combined with Notion's clean inline property display, side tables, and drag-to-create simplicity.

### Timeline View
#### (Projects Example)
![timeline-view](https://github.com/user-attachments/assets/0e106170-0f3c-4e68-817c-26194f11a063)

#### (Historical Example)
![timeline-view-bce](https://github.com/user-attachments/assets/e2e5e02a-4ac8-4c61-817c-8eca695422af)

### Sequences View
![sequences-view](https://github.com/user-attachments/assets/f827a28f-054b-4f4d-8176-2cf5611b8e23)

---

## Feature List

### Timeline View

| Category | Feature |
|----------|---------|
| **Scales** | 7 time scales — Hour, Day, Week, Month, Quarter, Year, Decade (including Century and Millennium) |
| **Auto-Scale** | Automatically selects the optimal scale for the current viewport width |
| **BCE / Historical Dates** | Full support for negative years (e.g., -500 for 500 BCE) on a numeric fractional-year axis |
| **Bars** | Horizontal SVG bars representing date ranges, with configurable height, corner radius, and opacity |
| **Point Events** | Single-date entries rendered as diamond-shaped markers |
| **Ongoing Events** | Entries with a start date but no end date extend to today with a dashed border and gradient fade |
| **Fuzzy Dates** | Uncertainty ranges via `earliest-start` and `latest-end` properties, shown as lighter-colored extensions |
| **Today Marker** | Vertical line at today's date with optional pulse animation |
| **Calendar Markers** | User-defined vertical lines or shaded bands marking custom dates or date ranges |
| **Dependency Arrows** | Curved SVG arrows between entries — green when satisfied, red on conflict |
| **Drag-to-Move** | Click and drag bars to reschedule (writes new dates back to frontmatter) |
| **Drag-to-Resize** | Drag the left or right edge of a bar to change its start or end date |
| **Drag-to-Create** | Click empty space and drag to create a new entry with that date range |
| **Measurement Tool** | Press `M`, click two points, and see the elapsed time between them |
| **Side Table** | Notion-style scrollable property columns alongside the timeline |
| **Property Badges** | Display up to 3 property values inline on each bar |
| **Grouped Rows** | Group entries by any property with collapsible headers |
| **Color by Property** | Dynamically color bars by a select/text property |
| **Per-Entry Locking** | Set `locked: true` in frontmatter to prevent accidental edits |
| **Global Lock** | Lock the entire view to prevent all drag operations |
| **Mobile Auto-Lock** | Optional automatic locking on touch devices |
| **Keyboard Navigation** | Arrow keys, Tab, Enter, Delete, Escape, Ctrl+A, zoom keys (1–7, +/−) |
| **Selection Highlighting** | Click to select; selected entries get a purple highlight glow |
| **Context Menus** | Right-click on bars or empty space for actions (open, edit, duplicate, delete, add dependency, etc.) |
| **Hover Tooltips** | Hover over any bar to see name, dates, dependencies, and properties |
| **Viewport Culling** | For large datasets (150+ entries), only visible bars are rendered for performance |
| **Touch Support** | Swipe, pinch-to-zoom, and long-press on mobile and tablet |
| **Style Settings Integration** | 40+ CSS custom properties exposed for deep visual customization |

### Sequence View

| Category | Feature |
|----------|---------|
| **Ordinal Axis** | Integer-based positional axis (1, 2, 3…) instead of dates |
| **Span Bars** | Entries can span multiple positions using `order` and `order-end` properties |
| **Dense Mode** | Collapse gaps between non-contiguous ordinal values |
| **Drag-to-Move** | Drag entries to reorder (writes back to frontmatter) |
| **Drag-to-Resize** | Drag edges to change position span |
| **Drag-to-Create** | Click and drag to create new ordered entries |
| **Dependency Arrows** | Same curved, color-coded arrows as Timeline View |
| **Side Table** | Scrollable property columns |
| **Property Badges** | Up to 3 inline property values per bar |
| **Color by Property** | Dynamic coloring by any property |
| **Per-Entry Locking** | Same locking system as Timeline View |
| **Keyboard Navigation** | Full keyboard support |
| **Context Menus** | Right-click actions |
| **Touch Support** | Mobile and tablet gestures |
| **Style Settings** | Shares the same 40+ customization variables |

### Shared Features (Both Views)

Both views share a unified interaction model and rendering pipeline:

- Drag-to-move, drag-to-resize, drag-to-create
- Dependency arrows with conflict detection
- Selection and keyboard navigation
- Context menus and hover tooltips
- Side table with scrollable property columns
- Up to 3 property badges on bars
- Per-entry and global locking
- Color-by-property
- Grouped/collapsible rows
- Mobile and touch support
- Deep Style Settings integration

### What Differentiates the Two Views

| | Timeline View | Sequence View |
|---|---|---|
| **Axis** | Fractional-year (temporal) | Integer (ordinal) |
| **Entry position** | Determined by date properties | Determined by numeric `order` property |
| **Scales** | 7 time scales with auto-selection | Fixed step width, no scale switching |
| **Today marker** | Yes | No |
| **BCE dates** | Yes | N/A |
| **Fuzzy dates** | Yes | No |
| **Point events** | Diamond markers for single dates | Single-position bars |
| **Ongoing events** | Extends to today | N/A |
| **Measurement tool** | Yes (press M) | No |
| **Calendar markers** | Yes | No |
| **Dense mode** | No | Yes (collapses ordinal gaps) |

---

## Detailed Usage Guide

### Getting Started

Time & Line works as a view type inside Obsidian Bases. To use it:

1. Create or open a **Base** in Obsidian.
2. Add a new view and select **Timeline** or **Sequence** from the view type picker.
3. In the view's options panel, map your frontmatter properties to the view's fields (start date, end date, color property, etc.).

Each note in the Base becomes an entry on the timeline or sequence. The plugin reads and writes frontmatter properties directly, so your data always stays in your notes.

---

### Situation 1: Project Planning with Gantt Charts

**View:** Timeline · **Scale:** Week or Month

You're managing a software project with phases, milestones, and dependencies.

**Setup:**
- Create notes for each task or phase with `start-date` and `end-date` properties in frontmatter.
- In the Timeline view options, map these to the start and end date fields.
- Set a `status` or `team` property, then assign it as the **Color by** property so each team's tasks are visually distinct.
- Set `status` as one of the three **Bar Property** slots so it displays directly on each bar.

**Using dependencies:**
- Add a `blocked-by` property to any task that can't start until another finishes. Use Obsidian wikilinks: `blocked-by: "[[Design Review]]"`.
- Arrows will appear between connected tasks. Green arrows mean the dependency is satisfied (the blocking task ends before the dependent task starts). Red arrows mean there's a scheduling conflict.
- Right-click any bar and choose **Add dependency** to link tasks with a fuzzy search picker.

**Day-to-day use:**
- Drag bars left or right to reschedule tasks. The frontmatter updates automatically.
- Drag bar edges to extend or shorten durations.
- Press `T` to jump the viewport to today.
- Use keyboard `+`/`−` or number keys `1`–`7` to switch between scales (zoom into a week view for daily standup, zoom out to quarter view for stakeholder updates).

**Milestones:**
- Create notes with only a `start-date` (no end date). These render as diamond-shaped point events — perfect for milestones, deadlines, or decision gates.

---

### Situation 2: Historical Research Timeline

**View:** Timeline · **Scale:** Year, Decade, or Century · **BCE enabled**

You're building a timeline of ancient civilizations or historical events spanning thousands of years.

**Setup:**
- Use year-only dates in frontmatter: `start-date: -3000` for 3000 BCE, `end-date: -2000` for 2000 BCE.
- Enable **BCE dates** in the view options.
- Set **Color by** to a `civilization` or `era` property.

**Using fuzzy dates:**
- Historical dates are often uncertain. Add `earliest-start` and `latest-end` properties to represent scholarly disagreement about dating.
- For example, if an event is traditionally dated to 1200 BCE but could be as early as 1250 BCE or as late as 1150 BCE, set `start-date: -1200`, `earliest-start: -1250`, `latest-end: -1150`.
- The bar renders at the primary date, with lighter-colored extensions showing the uncertainty range.

**Using the measurement tool:**
- Press `M` to activate the measurement tool.
- Click on one event, then another. A floating label shows the exact duration between them (e.g., "247 years, 3 months").
- Useful for answering questions like "How long after the fall of Rome did Charlemagne's empire begin?"

**Calendar markers:**
- In plugin settings, add vertical line markers for well-known reference dates (e.g., "Fall of Rome: 476 CE").
- Add shaded band markers for eras (e.g., "Bronze Age Collapse: -1200 to -1150").
- These appear across the timeline as persistent visual anchors.

---

### Situation 3: Content Calendar or Editorial Pipeline

**View:** Timeline · **Scale:** Day or Week

You're managing a content calendar with articles at various stages of production.

**Setup:**
- Each note represents a piece of content with `publish-date` (start) and optionally a `deadline` (end).
- Set **Color by** to a `stage` property (e.g., Draft, Review, Scheduled, Published).
- Map `author` and `stage` as **Bar Properties** so they appear directly on each bar.

**Ongoing items:**
- Content in progress has a `publish-date` but no `deadline`. These render as ongoing events — bars that extend to today with a dashed right edge and fade, making it visually clear what's currently active.

**Drag-to-create:**
- Click on an empty row and drag across a date range to create a new content item. A ghost bar appears during the drag. On release, a new note is created with the selected dates populated in frontmatter.

**Side table:**
- Enable the side table to see `author`, `stage`, `word-count`, and other properties in scrollable columns next to the timeline. This gives you a combined Gantt + spreadsheet view.

---

### Situation 4: Process Workflow or Pipeline Stages

**View:** Sequence

You're modeling a multi-step process: an onboarding workflow, a manufacturing pipeline, or a decision tree.

**Setup:**
- Create notes for each step with an `order` property (1, 2, 3, …).
- For steps that span multiple positions (e.g., "Quality Assurance" covers positions 4–6), add `order-end: 6`.
- Map `department` or `owner` as the **Color by** property.

**Dense mode:**
- If your ordinal values aren't contiguous (e.g., orders 1, 2, 5, 10, 20), enable **Dense layout** in view options. This collapses the gaps so all entries sit shoulder-to-shoulder.

**Reordering:**
- Drag entries to new positions. The `order` property in frontmatter updates to reflect the new arrangement.
- Use dependencies to show which steps must complete before others can begin.

---

### Situation 5: Sprint Planning and Team Coordination

**View:** Timeline · **Scale:** Day or Week

You're running two-week sprints and need to visualize who's working on what.

**Setup:**
- Group entries by an `assignee` property. Each person gets their own collapsible row group.
- Set **Color by** to `priority` (Critical = red, High = orange, Normal = blue).
- Map `story-points` and `sprint` as **Bar Properties** for at-a-glance context.

**Locking:**
- Once a sprint is locked, set `locked: true` on committed items so they can't be accidentally dragged.
- Or toggle the global lock to freeze the entire view during sprint review.
- Enable **Lock on mobile** if team members view the timeline on tablets during standup.

**Today marker:**
- The pulsing today line shows where you are in the sprint at a glance.
- Press `T` from anywhere to snap the viewport back to today.

---

### Situation 6: Personal Life Timeline or Journal

**View:** Timeline · **Scale:** Month, Quarter, or Year

You're building a personal timeline — jobs, moves, relationships, milestones.

**Setup:**
- Notes for life events with `start-date` and `end-date` (or just `start-date` for point events like "Graduated").
- Color by a `category` property: Career, Education, Travel, Personal.
- Use calendar markers to add reference bands like "Lived in Portland: 2015-01-01 to 2019-06-15."

**Point events vs. ranges:**
- Job held for 3 years → bar (start and end dates)
- Wedding day → diamond point event (start date only)
- Ongoing role → ongoing bar (start date, no end)

**Measurement:**
- Press `M` and click between two life events to see exactly how much time passed between them.

---

### Situation 7: Ranked or Prioritized Backlog

**View:** Sequence

You're maintaining a prioritized backlog or a ranked list where order matters but dates don't.

**Setup:**
- Each item gets an `order` property reflecting its priority rank.
- Color by `effort` or `impact` to see at a glance which high-priority items are also high-effort.
- Show `estimate` and `requester` as bar properties.

**Reordering:**
- Drag items to reprioritize. The `order` values rewrite automatically.
- Use dependencies to show "this item must be done before that one" regardless of their rank position.

---

### Keyboard Shortcuts Reference

| Key | Action | View |
|-----|--------|------|
| `←` `→` | Navigate selection chronologically / by order | Both |
| `↑` `↓` | Move selection between rows | Both |
| `Tab` / `Shift+Tab` | Sequential entry navigation | Both |
| `Enter` | Open selected entry in editor | Both |
| `Delete` / `Backspace` | Delete selected entry (with confirmation) | Both |
| `Escape` | Clear selection | Both |
| `Ctrl/Cmd+A` | Select all entries | Both |
| `T` | Scroll to today | Timeline |
| `+` / `=` | Zoom in (finer scale) | Timeline |
| `−` | Zoom out (coarser scale) | Timeline |
| `1`–`7` | Jump to scale by index (Hour → Decade) | Timeline |
| `M` | Toggle measurement tool | Timeline |

---

### Style Settings Customization

Time & Line integrates with the [Style Settings](https://github.com/mgmeyers/obsidian-style-settings) community plugin, exposing 40+ CSS custom properties organized into groups:

- **Bars** — Height, gap, opacity, corner radius, label size, badge opacity
- **Grid & Background** — Gridline colors, alternating band opacity
- **Today Marker** — Color, width, pulse animation toggle
- **Dependency Arrows** — Satisfied/conflict colors, opacity, hover width
- **Selection** — Highlight color, stroke width
- **Tooltips** — Border radius, max width, shadow intensity
- **Group Headers** — Background opacity, font size
- **Typography** — Header, table, and control font sizes
- **Hover & Animation** — Bar lift on hover, shadow opacity
- **Measure Tool** — Marker color
- **Calendar Markers** — Line opacity, band opacity, label size
- **Locked Entries** — Lock icon opacity

All values can be adjusted per-vault to match your theme.

---

## Planned Features

The following features are planned but not yet implemented:

### Export / Sharing
- **Export as image** — Export the current timeline view as a PNG or SVG image.
- **Copy date range to clipboard** — Select a date range and copy the visible portion of the timeline for pasting into other applications.

---


## Installation (Beta)

This plugin is currently in beta and not yet available in the Obsidian Community Plugin Browser.

To install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install the BRAT plugin from Obsidian's Community Plugins browser
   (Settings → Community Plugins → Browse → search "BRAT").
2. Enable BRAT in your Community Plugins list.
3. Open the command palette (Cmd/Ctrl + P) and run:
   **BRAT: Add a beta plugin for testing**
4. Paste this repository URL: `https://github.com/sabidurian/timeline-gantt-view`
5. Click **Add Plugin**.
6. Enable the plugin in Settings → Community Plugins.

### Updating

BRAT checks for updates automatically. You can also manually check:
- Open BRAT settings and click the refresh icon next to the plugin name, or
- Run the command **BRAT: Check for updates to all beta plugins and themes**.

### Reporting Issues

Please report bugs and feedback via
[GitHub Issues](https://github.com/sabidurian/timeline-gantt-view/issues).
Include your Obsidian version, OS, and steps to reproduce.

### ⚠️ Beta Notice

This plugin is under active development. Back up your vault before installing.
Beta plugins may cause unexpected behavior. If you encounter problems,
you can remove the plugin by clicking the X next to it in BRAT's settings,
or by disabling it in Community Plugins.
