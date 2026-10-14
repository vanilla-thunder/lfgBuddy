'use strict';

// Loads every activity from its own subdirectory (server/activities/<id>/),
// each an isolated module: activity.js for the definition, images/ for its
// pictures. This module owns everything about "what an activity is" —
// server/index.js only knows the room/socket protocol around it.

const fs = require('fs');
const path = require('path');
const express = require('express');

const ACTIVITIES_DIR = __dirname;
const ACTIVITY_TYPES = ['dungeon', 'raid'];

function imageUrl(activityId, filename) {
  return `/activities/${activityId}/images/${filename}`;
}

function resolveArea(activityId, area) {
  if (area.type !== 'toggle-svg') return area;
  return {
    ...area,
    overlay: { ...area.overlay, svg: imageUrl(activityId, area.overlay.svg) },
  };
}

function resolveOptionLists(activityId, optionLists) {
  return Object.fromEntries(
    Object.entries(optionLists).map(([name, options]) => [
      name,
      options.map((o) => (o.icon ? { ...o, icon: imageUrl(activityId, o.icon) } : o)),
    ])
  );
}

function loadActivity(id) {
  const def = require(path.join(ACTIVITIES_DIR, id, 'activity.js'));
  if (def.type !== undefined && !ACTIVITY_TYPES.includes(def.type)) {
    throw new Error(`Activity "${id}" has invalid type "${def.type}" (expected one of: ${ACTIVITY_TYPES.join(', ')})`);
  }
  return {
    id,
    name: def.name,
    type: def.type ?? null,
    active: def.active ?? true,
    thumbnail: def.thumbnail ? imageUrl(id, def.thumbnail) : null,
    optionLists: resolveOptionLists(id, def.optionLists ?? {}),
    encounters: (def.encounters ?? []).map((encounter) => ({
      id: encounter.id,
      name: encounter.name,
      image: imageUrl(id, encounter.image),
      areas: encounter.areas.map((area) => resolveArea(id, area)),
    })),
  };
}

function discoverActivityIds() {
  return fs
    .readdirSync(ACTIVITIES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ACTIVITIES_DIR, entry.name, 'activity.js')))
    .map((entry) => entry.name)
    .sort();
}

const activities = discoverActivityIds().map(loadActivity);
const activitiesById = new Map(activities.map((a) => [a.id, a]));

// activityId -> encounterId -> areaId -> area def (validates set-icon/toggle-svg)
const areasByActivityEncounter = new Map(
  activities.map((activity) => [
    activity.id,
    new Map(activity.encounters.map((encounter) => [encounter.id, new Map(encounter.areas.map((a) => [a.id, a]))])),
  ])
);

// activityId -> optionListName -> Set<optionId> (validates set-icon)
const optionIdsByActivity = new Map(
  activities.map((activity) => [
    activity.id,
    new Map(Object.entries(activity.optionLists).map(([name, options]) => [name, new Set(options.map((o) => o.id))])),
  ])
);

// Each activity's images/ folder is served at /activities/<id>/images/* —
// images live next to the activity that owns them instead of a shared
// public/ tree, so an activity is fully self-contained in one directory.
function mountStaticRoutes(app) {
  for (const id of activitiesById.keys()) {
    app.use(`/activities/${id}/images`, express.static(path.join(ACTIVITIES_DIR, id, 'images')));
  }
}

module.exports = {
  activities,
  activitiesById,
  areasByActivityEncounter,
  optionIdsByActivity,
  mountStaticRoutes,
};
