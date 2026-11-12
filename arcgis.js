// ArcGIS REST calls. Uses global fetch, so it also runs under Node for checks.
import { PORTAL, RETIREMENT_TABLE } from './config.js';
import { buildLookup, compareSchemas, parseReplacement, serviceParts } from './match.js';

const SHARING = PORTAL + '/sharing/rest';

async function request(url, params = {}, method = 'GET') {
  const body = new URLSearchParams(Object.entries({ f: 'json', ...params }).filter(([, value]) => value != null));
  const response = method === 'GET' ? await fetch(`${url}?${body}`) : await fetch(url, { method, body });
  const result = await response.json();
  if (result && result.error) {
    throw Object.assign(new Error(result.error.message || 'ArcGIS error ' + result.error.code), { code: result.error.code });
  }
  return result;
}

/** Run fn over items with a small worker pool. */
export async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

export const portalSelf = (token) => request(`${SHARING}/portals/self`, { token });

/** Yield the organization's members (first 10,000), for the owner filter. */
export async function* orgUsers(token) {
  for (let start = 1; start > 0 && start <= 10000;) {
    const page = await request(`${SHARING}/portals/self/users`, { token, start, num: 100, sortField: 'username' });
    yield* page.users;
    start = page.nextStart;
  }
}

// ---- Step a: retirement table -> lookup of IDs and service URLs --------------------------

async function retirementRows() {
  const rows = [];
  for (;;) {
    const page = await request(`${RETIREMENT_TABLE}/query`, {
      where: '1=1', outFields: 'item_id,owner,title,item_type,superceded_by',
      orderByFields: 'objectid', resultOffset: rows.length, resultRecordCount: 1000,
    });
    rows.push(...page.features.map((feature) => feature.attributes));
    if (!page.exceededTransferLimit || !page.features.length) return rows;
  }
}

/** Read public item metadata for many IDs, 50 per search request. IDs that are not public are absent. */
async function publicItems(ids) {
  const items = new Map();
  const batches = [];
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
  await pool(batches, 4, async (batch) => {
    const page = await request(`${SHARING}/search`, { q: `id:(${batch.join(' OR ')})`, num: 100 });
    for (const item of page.results) items.set(item.id, { id: item.id, title: item.title, type: item.type, url: item.url });
  });
  return items;
}

export async function loadLookup() {
  const rows = await retirementRows();
  const ids = new Set(rows.map((row) => row.item_id));
  for (const row of rows) parseReplacement(row.superceded_by).ids.forEach((id) => ids.add(id));
  const lookup = buildLookup(rows, await publicItems([...ids]));
  lookup.unresolved = rows.filter((row) => !lookup.items.has(row.item_id)).length;
  return lookup;
}

// ---- Step b: find the content to scan ----------------------------------------------------

const stamp = (ms) => String(ms).padStart(19, '0');

/**
 * Yield every item matching q. Search stops at 10,000 results, so a larger result set is
 * split by creation date until each slice fits.
 */
export async function* searchItems(q, token, from = 0, to = Date.now()) {
  const sliced = `(${q}) AND created:[${stamp(from)} TO ${stamp(to)}]`;
  const params = { q: sliced, token, num: 100, sortField: 'created', sortOrder: 'asc' };
  const first = await request(`${SHARING}/search`, { ...params, start: 1 });
  if (first.total > 10000 && to > from) {
    const middle = Math.floor((from + to) / 2);
    yield* searchItems(q, token, from, middle);
    yield* searchItems(q, token, middle + 1, to);
    return;
  }
  for (let page = first; ;) {
    yield* page.results;
    if (page.nextStart < 1) return;
    page = await request(`${SHARING}/search`, { ...params, start: page.nextStart });
  }
}

async function text(url, token) {
  const response = await fetch(url + (token ? `?token=${encodeURIComponent(token)}` : ''));
  const body = await response.text();
  if (body.startsWith('{"error"')) throw new Error(JSON.parse(body).error.message || 'ArcGIS error');
  return body;
}

export const itemData = (id, token) => text(`${SHARING}/content/items/${id}/data`, token);

const RESOURCE_LIMIT = 200;

/** JSON resources of an item (StoryMap and Experience Builder drafts and saved versions). */
export async function jsonResources(id, token) {
  const names = [];
  for (let start = 1; start > 0;) {
    const listing = await request(`${SHARING}/content/items/${id}/resources`, { token, start, num: 100 });
    for (const entry of listing.resources || []) if (/\.json$/i.test(entry.resource)) names.push(entry.resource);
    start = listing.nextStart || -1;
  }
  const documents = [];
  for (const name of names.slice(0, RESOURCE_LIMIT)) {
    documents.push({ name, text: await text(`${SHARING}/content/items/${id}/resources/${name.split('/').map(encodeURIComponent).join('/')}`, token) });
  }
  return { documents, skipped: Math.max(0, names.length - RESOURCE_LIMIT), limit: RESOURCE_LIMIT };
}

// ---- Step c: compare services and write the fix ------------------------------------------

/** Read a service or layer description. The token is only ever sent to arcgis.com hosts. */
export async function serviceInfo(url, token) {
  try {
    return await request(url);
  } catch (error) {
    if (!token || !/\.arcgis\.com$/i.test(new URL(url).hostname)) throw error;
    return request(url, { token });
  }
}

/** Compare the retiring and replacement services behind a planned swap. */
export async function schemaCheck(oldUrl, newUrl, token) {
  const parts = serviceParts(oldUrl);
  const whole = parts.layer === null && /^(map|feature)server$/.test(parts.kind);
  const suffix = whole ? '/layers' : '';
  const [before, after] = await Promise.all([serviceInfo(oldUrl + suffix, token), serviceInfo(newUrl + suffix, token)]);
  return compareSchemas(before, after);
}

export function updateItemData(item, textValue, token) {
  return request(`${SHARING}/content/users/${encodeURIComponent(item.owner)}/items/${item.id}/update`,
    { text: textValue, token }, 'POST');
}
