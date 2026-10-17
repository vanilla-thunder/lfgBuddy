'use strict';

// Area groups on the client side (rules and config: server/activities/index.js,
// enforced server-side in set-icon). Shared by both clients' icon pickers.

/**
 * Which options the icon picker for `area` shows, and which of them another
 * area of its group currently holds.
 *   'hide' group: options held elsewhere are left out.
 *   'move' group: all options, held ones marked (picking moves them here).
 * Ungrouped areas get every option unmarked.
 *
 * @param {{ areas: object[], groups?: Record<string, 'hide'|'move'> }} encounter
 * @param {Record<string, string>} icons   areaId -> optionId for this encounter
 * @param {{ id: string, group?: string }} area
 * @param {{ id: string }[]} options       the area's option list
 * @returns {{ option: object, heldBy: string|null }[]}
 */
// eslint-disable-next-line no-unused-vars
function groupPickerOptions(encounter, icons, area, options) {
  const mode = area.group ? encounter.groups?.[area.group] : undefined;
  if (!mode) return options.map((option) => ({ option, heldBy: null }));

  const heldBy = new Map(); // optionId -> areaId
  for (const peer of encounter.areas) {
    if (peer.id !== area.id && peer.group === area.group && icons[peer.id]) heldBy.set(icons[peer.id], peer.id);
  }

  return options
    .filter((option) => mode !== 'hide' || !heldBy.has(option.id))
    .map((option) => ({ option, heldBy: heldBy.get(option.id) ?? null }));
}
