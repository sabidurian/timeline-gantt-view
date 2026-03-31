/**
 * View options for the Sequence view — shown in the Bases "Configure view" panel.
 *
 * Unlike the Timeline view, Sequence uses an "order" property instead of
 * start/end dates. No scale dropdown, no BCE toggle, no today marker.
 */
import type { BasesViewConfig } from 'obsidian';

export function getSequenceViewOptions(config: BasesViewConfig): any[] {
  return [
    // ── Property selectors ──
    {
      type: 'property',
      key: 'orderProp',
      displayName: 'Order property',
      placeholder: 'e.g. order',
    },
    {
      type: 'property',
      key: 'orderEndProp',
      displayName: 'Order end (span)',
      placeholder: 'Optional — for multi-step spans',
    },
    {
      type: 'property',
      key: 'colorProp',
      displayName: 'Color by',
      placeholder: 'Select property…',
    },
    {
      type: 'property',
      key: 'dependencyProp',
      displayName: 'Dependency property',
      placeholder: 'e.g. blocked-by',
    },

    // ── Bar property display ──
    {
      type: 'property',
      key: 'barDisplayProp1',
      displayName: 'Bar property 1',
      placeholder: 'Property shown on bars',
    },
    {
      type: 'property',
      key: 'barDisplayProp2',
      displayName: 'Bar property 2',
      placeholder: 'Second property on bars',
    },
    {
      type: 'property',
      key: 'barDisplayProp3',
      displayName: 'Bar property 3',
      placeholder: 'Third property on bars',
    },

    // ── Focus filter ──
    {
      type: 'text',
      key: 'focusTag',
      displayName: 'Focus tag',
      placeholder: 'e.g. project — unfocused items are greyed out',
    },

    // ── Display toggles ──
    {
      type: 'toggle',
      key: 'showTable',
      displayName: 'Show side table',
      default: true,
    },
    {
      type: 'toggle',
      key: 'showArrows',
      displayName: 'Show dependencies',
      default: true,
    },
    {
      type: 'toggle',
      key: 'denseMode',
      displayName: 'Dense layout (collapse gaps)',
      default: false,
    },
  ];
}
