import { CLIENT_ID } from './config.js';
import { currentSession, signIn, signOut } from './auth.js';
import {
  itemData, jsonResources, loadLookup, pool, portalSelf, schemaCheck, searchItems, updateItemData,
} from './arcgis.js';
import { FIXABLE_TYPES, applySwap, findReferences, nodeAt, planSwap, pointer } from './match.js';

// Where each item type keeps its references.
const DATA_TYPES = ['Web Map', 'Web Scene', 'Group Layer', 'StoryMap', 'Dashboard', 'Web Experience',
  'Web Mapping Application', 'Hub Site Application', 'Hub Page', 'Notebook'];   // item data
const RESOURCE_TYPES = new Set(['StoryMap', 'Web Experience']);                  // plus JSON resources (drafts)
const URL_TYPES = ['Map Service', 'Feature Service', 'Image Service', 'Vector Tile Service', 'Scene Service']; // item URL only

const $ = (id) => document.getElementById(id);
const state = { session: null, self: null, lookup: null, results: [], unread: [], scanned: 0, stop: false };

function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (key in element) element[key] = value;
    else element.setAttribute(key, value);
  }
  element.append(...children.flat().filter((child) => child != null));
  return element;
}
const status = (message) => { $('status').textContent = message; };
const itemLink = (id, label) => h('a', {
  href: `https://${state.self.urlKey}.${state.self.customBaseUrl}/home/item.html?id=${id}`, target: '_blank', rel: 'noopener',
}, label || id);

// ---- Sign-in and filters ------------------------------------------------------------------

async function start() {
  if (!CLIENT_ID) return status('Set CLIENT_ID in config.js first.');
  try {
    state.session = await currentSession();
  } catch (error) {
    status(error.message);
  }
  if (!state.session) {
    $('account').replaceChildren(h('button', { onclick: signIn }, 'Sign in with ArcGIS'));
    if (!$('status').textContent) status('Sign in to scan your content for items Esri is retiring in December 2026.');
    return;
  }
  status('Loading your account and the retirement list…');
  [state.self, state.lookup] = await Promise.all([portalSelf(state.session.token), loadLookup()]);
  const user = state.self.user;
  state.admin = user.role === 'org_admin' || (user.privileges || []).includes('portal:admin:viewItems');
  $('account').replaceChildren(`${user.username}${state.admin ? ' (administrator)' : ''} · ${state.self.name} `,
    h('button', { onclick: signOut }, 'Sign out'));
  status(`${state.lookup.byId.size} retiring items loaded, ${state.lookup.byUrl.size} distinct service URLs.`);
  buildFilters();
}

function buildFilters() {
  const check = (type) => h('label', {}, h('input', { type: 'checkbox', name: 'type', value: type, checked: true }), ' ' + type);
  $('filters').replaceChildren(
    h('div', { class: 'row' },
      state.admin
        ? h('label', {}, 'Owner ', h('input', { type: 'text', name: 'owner', placeholder: 'blank = whole organization' }))
        : h('span', {}, 'Scanning content you own.'),
      h('label', {}, 'Sharing ', h('select', { name: 'access' },
        ...[['', 'Any'], ['private', 'Private'], ['shared', 'Groups'], ['org', 'Organization'], ['public', 'Public']]
          .map(([value, label]) => h('option', { value }, label)))),
      h('label', {}, 'Title or tag contains ', h('input', { type: 'text', name: 'text' }))),
    h('fieldset', {}, h('legend', {}, 'Item types (item data is read)'), DATA_TYPES.map(check)),
    h('fieldset', {}, h('legend', {}, 'Item types (only the item URL is checked)'), URL_TYPES.map(check)),
    h('div', { class: 'row' },
      h('button', { type: 'submit', id: 'scan' }, 'Scan'),
      h('button', { type: 'button', id: 'stop', disabled: true, onclick: () => { state.stop = true; } }, 'Stop')),
  );
  $('filters').hidden = false;
  $('filters').addEventListener('submit', (event) => { event.preventDefault(); scan(); });
}

// ---- Scan ---------------------------------------------------------------------------------

function buildQuery(form) {
  const quote = (value) => `"${value.replace(/"/g, '')}"`;
  const owner = state.admin ? form.get('owner').trim() : state.self.user.username;
  const parts = [owner ? `owner:${quote(owner)}` : `orgid:${state.self.id}`];
  const types = form.getAll('type');
  parts.push(`(${types.map((type) => `type:${quote(type)}`).join(' OR ')})`);
  if (form.get('access')) parts.push(`access:${form.get('access')}`);
  if (form.get('text').trim()) parts.push(`(${form.get('text').trim()})`);
  return { q: parts.join(' AND '), types: new Set(types) };
}

async function scan() {
  const { q, types } = buildQuery(new FormData($('filters')));
  if (!types.size) return status('Choose at least one item type.');
  Object.assign(state, { results: [], unread: [], scanned: 0, stop: false });
  $('results').replaceChildren();
  $('scan').disabled = true;
  $('stop').disabled = false;
  const progress = () => status(`Scanned ${state.scanned} items — ${state.results.length} affected` +
    (state.unread.length ? `, ${state.unread.length} could not be read` : '') + (state.stop ? ' (stopping…)' : '…'));
  try {
    let batch = [];
    const flush = async () => {
      await pool(batch, 6, async (item) => {
        if (state.stop) return;
        await scanItem(item);
        state.scanned += 1;
        progress();
      });
      batch = [];
    };
    for await (const item of searchItems(q, state.session.token)) {
      if (state.stop) break;
      if (!types.has(item.type)) continue;   // search matches words, so "Web Map" also finds "Web Mapping Application"
      batch.push(item);
      if (batch.length >= 60) await flush();
    }
    await flush();
    status(`${state.stop ? 'Stopped' : 'Done'}: ${state.scanned} items scanned, ${state.results.length} affected` +
      (state.unread.length ? `, ${state.unread.length} could not be read (listed below; not confirmed clean)` : '') + '.');
  } catch (error) {
    status('Scan failed: ' + error.message);
  }
  $('scan').disabled = false;
  $('stop').disabled = true;
  renderSummary();
}

async function scanItem(item) {
  const documents = [{ name: 'item URL', doc: { url: item.url || '' } }];
  try {
    if (DATA_TYPES.includes(item.type)) {
      const text = await itemData(item.id, state.session.token);
      documents.push({ name: 'data', text, doc: parse(text) });
    }
    if (RESOURCE_TYPES.has(item.type)) {
      const resources = await jsonResources(item.id, state.session.token);
      for (const entry of resources.documents) documents.push({ name: entry.name, doc: parse(entry.text) });
      if (resources.skipped) state.unread.push({ item, reason: `${resources.skipped} resource files beyond the first 20 were not read` });
    }
  } catch (error) {
    state.unread.push({ item, reason: error.message });
  }
  const locations = documents.flatMap((document) =>
    findReferences(document.doc, state.lookup).map((location) => ({ ...location, document })));
  if (!locations.length) return;
  const result = { item, locations };
  state.results.push(result);
  $('results').append(renderItem(result));
}

function parse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

// ---- Results ------------------------------------------------------------------------------

function renderSummary() {
  const unread = state.unread.length ? h('details', {}, h('summary', {}, `${state.unread.length} items could not be fully read`),
    h('ul', {}, state.unread.map(({ item, reason }) => h('li', {}, itemLink(item.id, item.title), ` — ${reason}`)))) : null;
  $('results').prepend(h('div', { class: 'summary' },
    h('strong', {}, `${state.results.length} affected items`),
    state.results.length ? h('button', { onclick: exportCsv }, 'Export CSV') : null), unread || '');
}

function renderItem(result) {
  const { item, locations } = result;
  const details = h('details', { class: 'item' },
    h('summary', {},
      h('span', { class: 'title' }, item.title),
      h('span', { class: 'meta' }, `${item.type} · ${item.owner} · ${item.access} · ${locations.length} reference${locations.length === 1 ? '' : 's'}`)),
    h('div', { class: 'location' }, itemLink(item.id, 'Open item page')));
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.filled) return;
    details.dataset.filled = '1';
    for (const location of locations) details.append(renderLocation(result, location));
  });
  return details;
}

function describe(location) {
  const names = location.candidates.slice(0, 3).flatMap((entry, index) => [index ? ', ' : '', itemLink(entry.id, entry.title)]);
  const more = location.candidates.length > 3 ? ` and ${location.candidates.length - 3} more` : '';
  return location.retiring ? ['Retiring: ', ...names]
    : [`One of ${location.candidates.length} retiring items sharing this service: `, ...names, more];
}

function renderLocation(result, location) {
  const node = typeof location.document.doc === 'object' ? nodeAt(location.document.doc, location.path) : null;
  const action = h('div', { class: 'action' });
  const row = h('div', { class: 'location' },
    h('div', {}, h('strong', {}, (node && node.title) || location.document.name), ' ',
      h('code', {}, `${location.document.name} ${pointer(location.path)}`)),
    h('div', {}, describe(location)),
    action);

  const editable = location.document.name === 'data' && FIXABLE_TYPES.has(result.item.type);
  const plan = editable ? planSwap(location, node, state.lookup)
    : { fixable: false, reason: replacementNote(location) + ' This location is reported only; fix it in the item\'s own editor.' };
  location.status = plan.fixable ? 'Swap possible, schema not checked' : plan.reason;
  if (!plan.fixable) {
    action.append(plan.reason);
    return row;
  }
  row.insertBefore(h('div', {}, 'Replacement: ', itemLink(plan.replacement.id, plan.replacement.title)), action);
  row.insertBefore(h('div', { class: 'change' }, plan.changes.map((change) => h('div', {}, `${change.key}: ${change.from} → ${change.to}`))), action);
  action.append('Comparing schemas…');
  schemaCheck(plan.oldUrl, plan.newUrl, state.session.token).then((schema) => {
    if (!schema.same) {
      location.status = 'Schema differs: ' + schema.problems.join('; ');
      action.replaceChildren(h('div', {}, h('span', { class: 'bad' }, 'Schema differs — not offered as a swap.'),
        h('ul', { class: 'problems' }, schema.problems.slice(0, 8).map((problem) => h('li', {}, problem)),
          schema.problems.length > 8 ? h('li', {}, `…and ${schema.problems.length - 8} more`) : null)));
      return;
    }
    location.status = 'Same schema; swap offered';
    const rename = h('input', { type: 'checkbox' });
    const title = h('input', { type: 'text', value: plan.replacement.title || '' });
    const button = h('button', {}, 'Apply swap');
    button.addEventListener('click', () => apply(result, location, plan, rename.checked ? title.value : null, action));
    action.replaceChildren(h('span', { class: 'good' }, 'Same schema.'),
      h('label', {}, rename, ' Also rename layer to'), title, button);
  }).catch((error) => {
    location.status = 'Schema could not be compared: ' + error.message;
    action.replaceChildren(h('span', { class: 'bad' }, `Schema could not be compared (${error.message}) — not offered as a swap.`));
  });
  return row;
}

function replacementNote(location) {
  const entry = location.candidates[0];
  if (!entry.replacementIds.length) return entry.replacementNote + '.';
  const replacement = state.lookup.items.get(entry.replacementIds[0]);
  return `Replacement: ${replacement ? replacement.title : entry.replacementIds[0]} (${entry.replacementIds.join(', ')}).`;
}

// ---- Apply one swap -----------------------------------------------------------------------

async function apply(result, location, plan, newTitle, action) {
  const { item } = result;
  const document = location.document;
  const node = nodeAt(document.doc, location.path);
  const changes = [...plan.changes];
  if (newTitle !== null && newTitle !== node.title) changes.push({ key: 'title', from: node.title, to: newTitle });
  const summary = changes.map((change) => `${change.key}: ${change.from} → ${change.to}`).join('\n');
  if (!confirm(`Save this change to "${item.title}"?\n\n${summary}\n\nA copy of the current item data is downloaded first.`)) return;
  action.replaceChildren('Saving…');
  try {
    const token = state.session.token;
    const current = await itemData(item.id, token);
    if (current !== document.text) throw new Error('The item changed since the scan. Scan again before fixing it.');
    if (/[:\[,]\s*-?\d{16,}/.test(current)) throw new Error('The item data holds numbers too large to rewrite safely in a browser. Fix it by hand.');
    download(`${item.id}-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, current);
    const next = applySwap(document.doc, location.path, changes);
    await updateItemData(item, JSON.stringify(next), token);
    const savedText = await itemData(item.id, token);
    const saved = nodeAt(JSON.parse(savedText), location.path) || {};
    const wrong = changes.filter((change) => saved[change.key] !== change.to);
    if (wrong.length) throw new Error(`Saved, but reading the item back did not show: ${wrong.map((change) => change.key).join(', ')}. Check the item.`);
    Object.assign(document, { text: savedText, doc: JSON.parse(savedText) });
    location.status = 'Fixed and read back';
    action.replaceChildren(h('span', { class: 'good' }, 'Saved and read back. Open the item to confirm it draws correctly.'));
  } catch (error) {
    location.status = 'Apply failed: ' + error.message;
    action.replaceChildren(h('span', { class: 'bad' }, error.message));
  }
}

function download(name, text, type = 'application/json') {
  const link = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

function exportCsv() {
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [['item_id', 'title', 'type', 'owner', 'sharing', 'document', 'location', 'retiring_ids', 'retiring_titles', 'replacement_ids', 'status']];
  for (const { item, locations } of state.results) {
    for (const location of locations) {
      rows.push([item.id, item.title, item.type, item.owner, item.access, location.document.name, pointer(location.path),
        location.candidates.map((entry) => entry.id).join(' '), location.candidates.map((entry) => entry.title).join(' | '),
        [...new Set(location.candidates.flatMap((entry) => entry.replacementIds))].join(' '),
        location.status || 'Not opened']);
    }
  }
  download('retiring-item-references.csv', rows.map((row) => row.map(cell).join(',')).join('\r\n'), 'text/csv');
}

start().catch((error) => status('Could not start: ' + error.message));
