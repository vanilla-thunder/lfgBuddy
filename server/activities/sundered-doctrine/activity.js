'use strict';

// Image/svg paths below are filenames only, relative to this activity's own
// images/ folder — the loader (server/activities/index.js) resolves them to
// the actual served URL.
module.exports = {
  name: 'Sundered Doctrine',
  type: 'dungeon',
  thumbnail: 'thumbnail.jpg',

  optionLists: {
    glyphs: [
      { id: 'darkness', label: 'Darkness', icon: 'glyphs/darkness.webp' },
      { id: 'drink', label: 'Drink', icon: 'glyphs/drink.webp' },
      { id: 'give', label: 'Give', icon: 'glyphs/give.webp' },
      { id: 'guardian', label: 'Guardian', icon: 'glyphs/guardian.webp' },
      { id: 'hive', label: 'Hive', icon: 'glyphs/hive.webp' },
      { id: 'kill', label: 'Kill', icon: 'glyphs/kill.webp' },
      { id: 'light', label: 'Light', icon: 'glyphs/light.webp' },
      { id: 'pyramid', label: 'Pyramid', icon: 'glyphs/pyramid.webp' },
      { id: 'savathun', label: 'Savathûn', icon: 'glyphs/savathun.webp' },
      { id: 'stop', label: 'Stop', icon: 'glyphs/stop.webp' },
      { id: 'traveller', label: 'Traveller', icon: 'glyphs/traveller.webp' },
      { id: 'witness', label: 'Witness', icon: 'glyphs/witness.webp' },
      { id: 'worm', label: 'Worm', icon: 'glyphs/worm.webp' },
      { id: 'worship', label: 'Worship', icon: 'glyphs/worship.webp' },
    ],
    markers: [
      { id: 'star', label: 'Star', emoji: '⭐' },
      { id: 'skip', label: 'Skip', emoji: '⏭️' },
      { id: 'bomb', label: 'Bomb', emoji: '💣' },
      { id: 'question', label: 'Unknown', emoji: '❓' },
    ],
  },

  encounters: [
    {
      id: 'encounter-1',
      name: 'Flooded Inspection',
      image: 'encounter-1.png',
      // Each glyph belongs to one room: picking a glyph another room already
      // has moves it here (see README → Area groups).
      groups: { rooms: 'move' },
      areas: [
        { id: 'L2', type: 'icon-select', optionList: 'glyphs', group: 'rooms', x: 10,  y: 15,  w: 50, h: 50 },
        { id: 'L1', type: 'icon-select', optionList: 'glyphs', group: 'rooms', x: 10,  y: -15, w: 50, h: 50 },
        { id: 'R2', type: 'icon-select', optionList: 'glyphs', group: 'rooms', x: -10, y: 15,  w: 50, h: 50 },
        { id: 'R1', type: 'icon-select', optionList: 'glyphs', group: 'rooms', x: -10, y: -15, w: 50, h: 50 },

        /*{
          id: 'hazard-toggle',
          type: 'toggle-svg',
          trigger: { x: 41, y: 84, w: 18, h: 10 },
          overlay: { x: 4, y: 55, w: 92, h: 22, svg: 'overlay-hazard.svg' },
        },*/
      ],
    },
    {
      id: 'encounter-2',
      name: 'Phase 2',
      image: 'encounter-2.svg',
      areas: [
        { id: 'spot-1', type: 'icon-select', optionList: 'roles', x: 24.5, y: 60, w: 18, h: 18 },
        { id: 'spot-2', type: 'icon-select', optionList: 'markers', x: 57.5, y: 60, w: 18, h: 18 },
        {
          id: 'safe-toggle',
          type: 'toggle-svg',
          trigger: { x: 41, y: 4, w: 18, h: 10 },
          overlay: { x: 30, y: 20, w: 40, h: 40, svg: 'overlay-safe.svg' },
        },
      ],
    },
  ],
};
