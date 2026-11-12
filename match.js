// Pure matching and swap logic: no network, no DOM. Tested by test/match.test.mjs.

const SERVICE_KINDS = 'MapServer|FeatureServer|ImageServer|VectorTileServer|SceneServer';
const SERVICE_RE = new RegExp(
  `https?://([^/\\s"'<>]+)(/[^\\s"'<>?#]*?/(${SERVICE_KINDS}))(?:/(\\d+))?`, 'gi');
const ID_RE = /\b[0-9a-f]{32}\b/g;

/** Item types whose layer references this tool can rewrite. Everything else is report-only. */
export const FIXABLE_TYPES = new Set(['Web Map', 'Web Scene', 'Group Layer']);

/** Split a service URL into a host+path key (case-insensitive, protocol-insensitive) and layer index. */
export function serviceParts(url) {
  SERVICE_RE.lastIndex = 0;
  const m = SERVICE_RE.exec(String(url || ''));
  if (!m) return null;
  return {
    key: (m[1] + m[2]).toLowerCase(),
    root: m[0].slice(0, m[0].length - (m[4] === undefined ? 0 : m[4].length + 1)),
    kind: m[3].toLowerCase(),
    layer: m[4] === undefined ? null : Number(m[4]),
    matched: m[0],
  };
}

/** The table's "Replacement Item" column is an ID, several IDs, or prose such as "No replacement item". */
export function parseReplacement(value) {
  const text = String(value || '').trim();
  const ids = text.toLowerCase().match(ID_RE) || [];
  return { ids, note: ids.length ? '' : text || 'No replacement listed' };
}

/**
 * Esri's retirement notice in an item description links "a new version of this item".
 * Returns that item's ID when the description holds exactly one such link.
 */
export function newVersionLink(description, ownId) {
  const anchors = /<a\b[^>]*href=['"][^'"]*?\b([0-9a-f]{32})\b[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
  const ids = new Set();
  for (const [, id, label] of String(description || '').matchAll(anchors)) {
    if (/new\s+version/i.test(label.replace(/<[^>]+>/g, '')) && id.toLowerCase() !== ownId) ids.add(id.toLowerCase());
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/**
 * The replacement is the "new version" link in the retiring item's description when there is
 * one, otherwise the table's. The table wins only when the description's item cannot be read
 * and the table's can.
 * @param rows   attributes from Esri's retirement table
 * @param items  Map of item id -> item metadata (retiring items and their replacements)
 */
export function buildLookup(rows, items) {
  const byId = new Map();
  const byUrl = new Map();
  for (const row of rows) {
    const meta = items.get(row.item_id) || {};
    const replacement = parseReplacement(row.superceded_by);
    if (replacement.ids.includes(row.item_id)) {   // seen in Esri's table: an item listed as its own replacement
      replacement.ids = [];
      replacement.note = "Esri's table lists this item as its own replacement, so there is nothing different to swap to";
    }
    const linked = meta.newVersionId || null;
    const tableIds = replacement.ids;
    const fromDescription = Boolean(linked) && (items.has(linked) || !tableIds.some((id) => items.has(id)));
    const other = fromDescription ? tableIds.filter((id) => id !== linked) : [linked].filter(Boolean);
    if (fromDescription) replacement.ids = [linked];
    const entry = {
      id: row.item_id, title: row.title, type: row.item_type, owner: row.owner,
      url: meta.url || null, replacementIds: replacement.ids, replacementNote: replacement.note,
      tableText: String(row.superceded_by || '').trim(),
      // 'table' also covers the usual case where table and description agree
      replacementSource: fromDescription && (other.length || !tableIds.length) ? 'description' : 'table',
      alternateId: other[0] || null,   // what the source that was not used says, when it differs
    };
    byId.set(entry.id, entry);
    const parts = serviceParts(entry.url);
    if (parts) {
      if (!byUrl.has(parts.key)) byUrl.set(parts.key, []);
      byUrl.get(parts.key).push(entry);
    }
  }
  return { byId, byUrl, items };
}

function scanString(value, lookup) {
  const hits = [];
  for (const id of new Set(value.toLowerCase().match(ID_RE) || [])) {
    if (lookup.byId.has(id)) hits.push({ kind: 'id', value: id, retiring: [lookup.byId.get(id)] });
  }
  SERVICE_RE.lastIndex = 0;
  for (let m; (m = SERVICE_RE.exec(value));) {
    const candidates = lookup.byUrl.get((m[1] + m[2]).toLowerCase());
    if (candidates) hits.push({ kind: 'url', value: m[0], retiring: candidates });
  }
  return hits;
}

/**
 * Walk a JSON document (or plain text) and return one location per object that mentions a
 * retiring item. A location is resolved when the evidence points at exactly one retiring item:
 * an item ID wins over a URL, because many retiring items share one service URL.
 */
export function findReferences(doc, lookup) {
  const byPath = new Map();
  const add = (path, key, hits) => {
    if (!hits.length) return;
    const id = JSON.stringify(path);
    if (!byPath.has(id)) byPath.set(id, { path, hits: [] });
    for (const hit of hits) byPath.get(id).hits.push({ key, ...hit });
  };
  const walk = (node, path) => {
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === 'string') add(path, key, scanString(child, lookup));
      else if (child && typeof child === 'object') walk(child, [...path, key]);
    }
  };
  if (typeof doc === 'string') add([], '(text)', scanString(doc, lookup));
  else if (doc && typeof doc === 'object') walk(doc, []);

  return [...byPath.values()].map((location) => {
    const idHits = location.hits.filter((hit) => hit.kind === 'id');
    const pool = (idHits.length ? idHits : location.hits).flatMap((hit) => hit.retiring);
    const candidates = [...new Map(pool.map((entry) => [entry.id, entry])).values()];
    return { ...location, candidates, retiring: candidates.length === 1 ? candidates[0] : null };
  });
}

export function pointer(path) {
  return path.length ? '/' + path.join('/') : '(top level)';
}

export function nodeAt(doc, path) {
  return path.reduce((node, key) => (node == null ? node : node[key]), doc);
}

/**
 * Decide whether a location can be fixed by swapping item ID and service URL.
 * Returns { fixable: false, reason } or { fixable: true, replacement, oldUrl, newUrl, changes }.
 * Schema compatibility is checked separately, against the live services.
 */
export function planSwap(location, node, lookup) {
  const no = (reason) => ({ fixable: false, reason });
  const targets = new Set(location.candidates.map((entry) => entry.replacementIds.join(',')));
  if (targets.size !== 1) return no('Several retiring items share this service URL and they have different replacements.');
  const sample = location.candidates[0];
  if (sample.replacementIds.length === 0) return no(sample.replacementNote);
  if (sample.replacementIds.length > 1) return no('The table lists more than one replacement; choose manually.');
  const replacement = lookup.items.get(sample.replacementIds[0]);
  if (!replacement) return no('The replacement item could not be read.');
  if (!node || typeof node.url !== 'string') return no('No service URL at this location to swap.');
  const oldParts = serviceParts(node.url);
  const bare = node.url.split(/[?#]/)[0].replace(/\/+$/, '');
  if (!oldParts || oldParts.matched !== bare) return no('The URL here is not a plain service URL.');
  if (!location.candidates.some((entry) => (serviceParts(entry.url) || {}).key === oldParts.key)) {
    return no('The URL here is not the retiring service.');
  }
  const newParts = serviceParts(replacement.url);
  if (!newParts) return no('The replacement item has no service URL.');
  if (newParts.kind !== oldParts.kind) {
    return no(`Service type changes (${oldParts.kind} to ${newParts.kind}); the layer must be re-added by hand.`);
  }
  // A replacement item can point at the very same service; then only the item ID changes.
  const sameService = newParts.key === oldParts.key;
  const newUrl = sameService ? bare : newParts.root + (oldParts.layer === null ? '' : '/' + oldParts.layer);
  const changes = sameService ? [] : [{ key: 'url', from: node.url, to: newUrl }];
  if (typeof node.itemId === 'string' && node.itemId !== replacement.id) {
    changes.push({ key: 'itemId', from: node.itemId, to: replacement.id });
  }
  if (!changes.length) return no('This layer already points at the replacement; nothing to change.');
  return { fixable: true, replacement, oldUrl: bare, newUrl, changes, sameService };
}

/** Return a copy of doc with the changes applied at path. Nothing else is touched. */
export function applySwap(doc, path, changes) {
  const copy = structuredClone(doc);
  const node = nodeAt(copy, path);
  for (const change of changes) {
    if (node[change.key] !== change.from) throw new Error(`Expected ${change.key} to be "${change.from}"`);
    node[change.key] = change.to;
  }
  return copy;
}

function compareLayer(label, oldInfo, newInfo, problems) {
  if ((oldInfo.geometryType || null) !== (newInfo.geometryType || null)) {
    problems.push(`${label}geometry type differs (${oldInfo.geometryType} vs ${newInfo.geometryType})`);
  }
  for (const key of ['pixelType', 'bandCount']) {
    if (oldInfo[key] !== newInfo[key]) problems.push(`${label}${key} differs (${oldInfo[key]} vs ${newInfo[key]})`);
  }
  const fields = new Map((newInfo.fields || []).map((field) => [field.name.toLowerCase(), field]));
  for (const field of oldInfo.fields || []) {
    if (field.type === 'esriFieldTypeOID') continue; // system row ID; its name varies between services
    const match = fields.get(field.name.toLowerCase());
    if (!match) problems.push(`${label}field ${field.name} is missing`);
    else if (match.type !== field.type) problems.push(`${label}field ${field.name} changes type`);
  }
}

/**
 * Compare old and new service descriptions. For a single layer pass its JSON; for a whole
 * service pass the "/layers" response ({layers, tables}). "Same" means: every old layer exists
 * under the same id, with the same geometry, and every old field exists with the same type.
 */
export function compareSchemas(oldInfo, newInfo) {
  const problems = [];
  const list = (info) => [...(info.layers || []), ...(info.tables || [])];
  if (oldInfo.layers || oldInfo.tables) {
    const next = new Map(list(newInfo).map((layer) => [layer.id, layer]));
    for (const layer of list(oldInfo)) {
      if (!next.has(layer.id)) problems.push(`layer ${layer.id} (${layer.name}) is missing`);
      else compareLayer(`layer ${layer.id}: `, layer, next.get(layer.id), problems);
    }
    if (!list(oldInfo).length) problems.push('the retiring service lists no layers to compare');
  } else if (oldInfo.fields || oldInfo.pixelType) {
    compareLayer('', oldInfo, newInfo, problems);
  } else {
    problems.push('nothing comparable was found in the retiring service description');
  }
  return { same: problems.length === 0, problems };
}
