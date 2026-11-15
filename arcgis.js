// ArcGIS REST calls. Uses global fetch, so it also runs under Node for checks.
import { LINK_FIXES, PORTAL, RETIREMENT_TABLE, SUGGESTIONS, URL_FIXES } from './config.js';
import { buildLookup, compareSchemas, matchLayer, newVersionLink, parseReplacement, retirementDate, serviceParts } from './match.js';

const SHARING = PORTAL + '/sharing/rest';

/**
 * fetch, tried again when the request never gets an answer. A browser reports a dropped
 * connection only as "Failed to fetch", and a long scan makes thousands of requests. Reads are
 * tried three times; a write is tried once, since it may have arrived.
 */
async function get(url, init) {
  const tries = init?.method === 'POST' ? 1 : 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (attempt >= tries) {
        const where = new URL(url);
        throw new Error(`no answer from ${where.hostname}${where.pathname.replace(/^.*\/rest\//, '/…/')} after ${count(tries)} (${error.message})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}
const count = (tries) => (tries === 1 ? '1 try' : `${tries} tries`);

async function request(url, params = {}, method = 'GET') {
  const body = new URLSearchParams(Object.entries({ f: 'json', ...params }).filter(([, value]) => value != null));
  const response = method === 'GET' ? await get(`${url}?${body}`) : await get(url, { method, body });
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

const brief = (item) => ({ id: item.id, title: item.title, type: item.type,
  url: URL_FIXES[item.id]?.url || item.url, urlNote: URL_FIXES[item.id]?.note || null,
  newVersionId: item.id in LINK_FIXES ? LINK_FIXES[item.id] : newVersionLink(item.description, item.id),
  similarId: newVersionLink(item.description, item.id, /similar\s+item/i),
  deprecated: item.contentStatus === 'deprecated', retires: retirementDate(item.description) });

/** One item's current details, in the shape search results have. */
export const itemInfo = (id, token) => request(`${SHARING}/content/items/${id}`, { token });

/** One item the signed-in user can see, in the same shape as the lookup's items. */
export const itemMeta = async (id, token) => brief(await request(`${SHARING}/content/items/${id}`, { token }));

/**
 * IDs of items ArcGIS itself records as using this one (what the item page shows as "Used by").
 * Owners and administrators only, and not every kind of reference is recorded.
 */
export async function recordedDependents(id, token) {
  const page = await request(`${SHARING}/content/items/${id}/dependencies/listDependentsTo`, { token, num: 100 });
  return (page.list || []).filter((entry) => /^[0-9a-f]{32}$/.test(entry.id || '')).map((entry) => entry.id);
}

/** Read public item metadata for many IDs, 50 per search request. IDs that are not public are absent. */
async function publicItems(ids) {
  const items = new Map();
  const batches = [];
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
  await pool(batches, 4, async (batch) => {
    const page = await request(`${SHARING}/search`, { q: `id:(${batch.join(' OR ')})`, num: 100 });
    for (const item of page.results) {
      items.set(item.id, brief(item));
    }
  });
  return items;
}

export async function loadLookup() {
  const rows = await retirementRows();
  const items = await publicItems(rows.map((row) => row.item_id));
  // Replacements, then the replacements' own newer versions, until nothing new turns up.
  const asked = new Set(items.keys());
  let wanted = [...rows.flatMap((row) => parseReplacement(row.superceded_by).ids), ...Object.values(SUGGESTIONS).map((entry) => entry.id)];
  for (let round = 0; round < 6; round += 1) {
    for (const item of items.values()) wanted.push(...[item.newVersionId, item.similarId].filter(Boolean));
    const missing = [...new Set(wanted)].filter((id) => !asked.has(id));
    if (!missing.length) break;
    missing.forEach((id) => asked.add(id));
    for (const [id, item] of await publicItems(missing)) items.set(id, item);
    wanted = [];
  }
  const lookup = buildLookup(rows, items, SUGGESTIONS);
  lookup.unresolved = rows.filter((row) => !lookup.items.has(row.item_id)).length;
  return lookup;
}

// ---- Step b: find the content to scan ----------------------------------------------------

/** How many items of each type a query matches: Map of lower-case type name -> count. */
export async function typeCounts(q, token) {
  const page = await request(`${SHARING}/search`, { q, token, num: 0, countFields: 'type', countSize: 200 });
  const values = page.aggregations?.counts?.[0]?.fieldValues || [];
  return new Map(values.map((entry) => [entry.value, entry.count]));
}

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
  const response = await get(url + (token ? `?token=${encodeURIComponent(token)}` : ''));
  const body = await response.text();
  if (!response.ok && !body.startsWith('{"error"')) throw new Error(`ArcGIS answered HTTP ${response.status}`);
  if (body.startsWith('{"error"')) throw new Error(JSON.parse(body).error.message || 'ArcGIS error');
  return body;
}

export const itemData = (id, token) => text(`${SHARING}/content/items/${id}/data`, token);

// A guard on memory, not an ArcGIS limit: six items are read at once, each decoded and parsed.
export const DATA_LIMIT = 100 * 1024 * 1024;

/** An item's data as bytes, or { tooLarge: bytes } without downloading it when it is over the limit. */
export async function itemBytes(id, token) {
  const response = await get(`${SHARING}/content/items/${id}/data` + (token ? `?token=${encodeURIComponent(token)}` : ''));
  // An item that is gone or not shared with this user answers with an error page, not data.
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`item data could not be read (HTTP ${response.status})`);
  }
  const length = Number(response.headers.get('content-length'));
  if (length > DATA_LIMIT) {
    await response.body?.cancel();
    return { tooLarge: length };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > DATA_LIMIT) return { tooLarge: bytes.length };
  if (bytes.length < 2000 && bytes[0] === 0x7b) {
    const body = JSON.parse(new TextDecoder().decode(bytes) || '{}');
    if (body.error) throw new Error(body.error.message || 'ArcGIS error');
  }
  return { bytes };
}

const RESOURCE_LIMIT = 200;

/** JSON resources of an item (StoryMap and Experience Builder drafts and saved versions). */
export async function jsonResources(id, token) {
  const names = [];
  const sizes = new Map();
  for (let start = 1; start > 0;) {
    const listing = await request(`${SHARING}/content/items/${id}/resources`, { token, start, num: 100 });
    for (const entry of listing.resources || []) {
      sizes.set(entry.resource, entry.size);
      // An empty file has nothing to read, and asking for one fails in a browser.
      if (/\.json$/i.test(entry.resource) && entry.size !== 0) names.push(entry.resource);
    }
    start = listing.nextStart || -1;
  }
  const documents = [];
  const failed = [];   // one resource that cannot be read must not hide the others
  for (const name of names.slice(0, RESOURCE_LIMIT)) {
    const path = (resource) => `${SHARING}/content/items/${id}/resources/${resource.split('/').map(encodeURIComponent).join('/')}`;
    const url = path(name);
    try {
      documents.push({ name, text: await text(url, token) });
    } catch (error) {
      // Seen on a 2019 beta StoryMap: the listed draft.json cannot be fetched, and the same file
      // answers one folder down, under resources/. Read that copy when it is there.
      const copy = sizes.has(`resources/${name}`) ? null : await text(path(`resources/${name}`), token).catch(() => null);
      if (copy && /^\s*[[{]/.test(copy)) {
        documents.push({ name: `resources/${name}`, text: copy });
        continue;
      }
      // Say what is known about the failure: the listed size, and whether the server answered at all.
      // A request a page may not read the answer to still shows that an answer came.
      const answered = await fetch(url + (token ? `?token=${encodeURIComponent(token)}` : ''), { mode: 'no-cors' }).then(() => true, () => false);
      failed.push(`${name}, listed as ${sizes.get(name) ?? 'unknown'} bytes: ${error.message}; ` +
        (answered ? 'the server did answer, but with something this page is not allowed to read or cannot decode' : 'the server gave no answer to a second kind of request either'));
    }
  }
  return { documents, failed, skipped: Math.max(0, names.length - RESOURCE_LIMIT), limit: RESOURCE_LIMIT };
}

// ---- Step c: compare services and write the fix ------------------------------------------

// At most four service requests run at once: an item with a dozen layers would otherwise send
// two dozen together, to servers that are slower and stricter than the sharing API.
let running = 0;
const waiting = [];
async function limited(fn) {
  if (running >= 4) await new Promise((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

async function readService(url, token, params) {
  try {
    return await limited(() => request(url, params));
  } catch (error) {
    const host = new URL(url).hostname;
    if (!token || !/\.arcgis\.com$/i.test(host)) throw error;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await limited(() => request(url, { ...params, token }));
      } catch (again) {
        // 498 is "invalid token". Try once more before believing it.
        if (again.code !== 498) throw again;
        if (attempt === 2) throw Object.assign(new Error(`${host} did not accept your sign-in (${again.message.replace(/\.$/, '')})`), { code: 498 });
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }
}

const services = new Map();
/**
 * Read a service or layer description. The token is only ever sent to arcgis.com hosts.
 * An answer is kept for the page session, so layers sharing a service ask for it once;
 * a failure is not kept.
 */
export function serviceInfo(address, token, params = {}) {
  // Old maps hold http:// addresses, which a browser will not request from an https page.
  const url = address.replace(/^http:\/\//i, 'https://');
  const key = `${url}?${JSON.stringify(params)}`;
  if (!services.has(key)) {
    services.set(key, readService(url, token, params).catch((error) => {
      services.delete(key);
      throw error;
    }));
  }
  return services.get(key);
}

/** The five most common values of a field, as [{ value, count }], for judging a field mapping. */
export async function topValues(layerUrl, field, oidField, token) {
  const page = await serviceInfo(`${layerUrl}/query`, token, {
    where: '1=1', returnGeometry: false, groupByFieldsForStatistics: field, orderByFields: 'n DESC', resultRecordCount: 5,
    outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: oidField, outStatisticFieldName: 'n' }]),
  });
  return page.features.map(({ attributes }) => {
    const key = Object.keys(attributes).find((name) => name.toLowerCase() === field.toLowerCase());
    return { value: attributes[key], count: attributes.n ?? attributes.N };
  });
}

/**
 * The layers of the replacement service, for a swap of one layer of the retiring service.
 * Layer numbers do not carry over between services, so the layer is matched by name.
 * Returns { oldName, layers: [{ id, name }], pick }; pick is null when the user has to choose.
 */
export async function layerOptions(oldUrl, newUrl, token) {
  const [before, service] = await Promise.all([serviceInfo(oldUrl, token), serviceInfo(serviceParts(newUrl).root, token)]);
  const layers = [...(service.layers || []), ...(service.tables || [])].map(({ id, name }) => ({ id, name }));
  if (!layers.length) throw new Error('the replacement service lists no layers');
  return { oldName: before.name, layers, pick: matchLayer({ id: serviceParts(oldUrl).layer, name: before.name }, layers) };
}

/** Compare the retiring and replacement services behind a planned swap. */
export async function schemaCheck(oldUrl, newUrl, token) {
  const parts = serviceParts(oldUrl);
  const whole = parts.layer === null && /^(map|feature)server$/.test(parts.kind);
  const suffix = whole ? '/layers' : '';
  const [before, after] = await Promise.all([serviceInfo(oldUrl + suffix, token), serviceInfo(newUrl + suffix, token)]);
  const result = compareSchemas(before, after);
  for (const field of result.fields) {
    field.oldLayer = oldUrl + (field.layerId === null ? '' : `/${field.layerId}`);
    field.newLayer = newUrl + (field.layerId === null ? '' : `/${field.layerId}`);
  }
  return result;
}

export function updateItemData(item, textValue, token) {
  return request(`${SHARING}/content/users/${encodeURIComponent(item.owner)}/items/${item.id}/update`,
    { text: textValue, token }, 'POST');
}
