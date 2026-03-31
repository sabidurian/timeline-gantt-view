/**
 * View options shown in the Bases "Configure view" panel.
 *
 * Phase 7: Full set of property pickers, dropdowns, toggles, and option groups.
 */
import type { BasesViewConfig } from 'obsidian';
import { SCALES } from './scale/TimeScale';

// Import scales so the registry is populated before we build the dropdown
import './scale/scales/index';

export function getViewOptions(config: BasesViewConfig): any[] {
  // Build scale dropdown options: { scaleId: "Label" }
  const scaleOptions: Record<string, string> = { auto: 'Auto' };
  for (const scale of SCALES) {
    scaleOptions[scale.id] = scale.label;
  }

  return [
    // ── Property selectors ──
    {
      type: 'property',
      key: 'startDateProp',
      displayName: 'Start date',
      placeholder: 'Select property…',
    },
    {
      type: 'property',
      key: 'endDateProp',
      displayName: 'End date',
      placeholder: 'Select property…',
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
    {
      type: 'property',
      key: 'earliestStartProp',
      displayName: 'Earliest start',
      placeholder: 'Uncertainty: earliest possible start',
    },
    {
      type: 'property',
      key: 'latestEndProp',
      displayName: 'Latest end',
      placeholder: 'Uncertainty: latest possible end',
    },

    // ── Bar property badges ──
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

    // ── Scale ──
    {
      type: 'dropdown',
      key: 'scaleId',
      displayName: 'Default scale',
      default: 'auto',
      options: scaleOptions,
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
      key: 'showToday',
      displayName: 'Show today marker',
      default: true,
    },

    // ── Historical group ──
    {
      type: 'group',
      displayName: 'Historical',
      items: [
        {
          type: 'toggle',
          key: 'enableBCE',
          displayName: 'Enable BCE dates',
          default: true,
        },
      ],
    },
  ];
}
