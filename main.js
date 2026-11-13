import { CLIENT_ID } from './config.js';
import { currentSession, signIn, signOut } from './auth.js';
import {
  DATA_LIMIT, itemBytes, itemData, itemMeta, jsonResources, loadLookup, orgUsers, pool, portalSelf, schemaCheck, searchItems,
  topValues, typeCounts, updateItemData,
} from './arcgis.js';
import { describeUses, fieldUses, renameFields } from './fields.js';
import { readContent } from './content.js';
import { FIXABLE_TYPES, applySwap, findReferences, nodeAt, planSwap, pointer, replacementChain } from './match.js';
import { GROUPS, NOT_SCANNED, RESOURCE_TYPES, isKnownType, isScanned } from './types.js';

const $ = (id) => document.getElementById(id);
const state = { session: null, self: null, lookup: null, results: [], unread: [], scanned: 0, stop: false };

function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (key in element && key !== 'list') element[key] = value;   // input.list is read-only
    else element.setAttribute(key, value);
  }
  element.append(...children.flat().filter((child) => child != null));
  return element;
}
const status = (message) => { $('status').textContent = message; };
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
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
  // The owner filter is for people who can also fix other members' items.
  state.admin = user.role === 'org_admin' || (user.privileges || []).includes('portal:admin:updateItems');
  $('account').replaceChildren(`${user.username}${state.admin ? ' (administrator)' : ''} · ${state.self.name} `,
    h('button', { onclick: signOut }, 'Sign out'));
  status(`${count(state.lookup.byId.size, 'retiring item')} loaded, ${count(state.lookup.byUrl.size, 'distinct service URL')}.`);
  // Offer only the item types that exist in the content this person can scan.
  const scope = state.admin ? `orgid:${state.self.id}` : `owner:"${user.username}"`;
  const counts = await typeCounts(scope, state.session.token).then((found) => (found.size ? found : null), () => null);
  buildFilters(counts);
  if (state.admin) loadOwners();
}

/** Fill the owner picker in the background. If members cannot be listed, the box still accepts a typed username. */
async function loadOwners() {
  try {
    for await (const user of orgUsers(state.session.token)) {
      $('owners').append(h('option', { value: user.username, label: user.fullName || '' }));
    }
  } catch { /* typed usernames still work */ }
}

/** One collapsible group of type checkboxes with its own all/none buttons. */
function typeGroup(label, note, types, counts) {
  const boxes = types.map((type) => h('input', { type: 'checkbox', name: 'type', value: type, checked: true }));
  const set = (on) => () => boxes.forEach((box) => { box.checked = on; });
  return h('details', { class: 'group', open: true },
    h('summary', {}, h('strong', {}, label), h('span', { class: 'meta' }, ` — reads ${note}`)),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: set(true) }, 'All'), h('button', { type: 'button', onclick: set(false) }, 'None')),
    h('fieldset', {}, boxes.map((box, index) => h('label', {}, box, ` ${types[index]}`,
      counts ? h('span', { class: 'meta' }, ` ${(counts.get(types[index].toLowerCase()) || 0).toLocaleString()}`) : null))));
}

/**
 * counts: how many items of each type the signed-in user can scan, or null if that could not be
 * read. With counts, only types that exist in the content are offered.
 */
function buildFilters(counts) {
  const present = (type) => !counts || counts.has(type.toLowerCase());
  const groups = GROUPS.map((group) => typeGroup(group.label, group.note, group.types.filter(present), counts))
    .filter((group) => group.querySelector('input'));
  const other = counts ? [...counts.keys()].filter((type) => type && !isKnownType(type)).sort() : [];
  if (other.length) groups.push(typeGroup('Other types', 'item data when it is text or a zip file', other, counts));
  const skipped = NOT_SCANNED.map((group) => ({ ...group, types: group.types.filter((type) => counts && counts.has(type.toLowerCase())) }))
    .filter((group) => group.types.length);
  const setAll = (on) => () => $('filters').querySelectorAll('input[name=type]').forEach((box) => { box.checked = on; });

  $('filters').replaceChildren(
    h('div', { class: 'row' },
      state.admin
        ? h('label', {}, 'Owner ', h('input', { type: 'text', name: 'owner', list: 'owners', placeholder: 'blank = whole organization' }),
          h('datalist', { id: 'owners' }))
        : h('span', {}, 'Scanning content you own.'),
      h('label', {}, 'Sharing ', h('select', { name: 'access' },
        ...[['', 'Any'], ['private', 'Private'], ['shared', 'Groups only'], ['org', 'Organization'], ['public', 'Public']]
          .map(([value, label]) => h('option', { value }, label)))),
      h('label', {}, 'Title or tag contains ', h('input', { type: 'text', name: 'text' }))),
    h('div', { class: 'row' }, h('strong', {}, 'Item types'),
      h('button', { type: 'button', onclick: setAll(true) }, 'Select all'),
      h('button', { type: 'button', onclick: setAll(false) }, 'Deselect all')),
    ...groups,
    skipped.length ? h('details', { class: 'group' },
      h('summary', {}, h('span', { class: 'meta' }, `Not scanned: ${count(skipped.reduce((sum, group) => sum + group.types.length, 0), 'other type')} in this content`)),
      skipped.map((group) => h('p', { class: 'meta' }, `${group.types.join(', ')} — ${group.reason}.`))) : '',
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
  const types = form.getAll('type').filter(isScanned);
  parts.push(`(${types.map((type) => `type:${quote(type)}`).join(' OR ')})`);
  if (form.get('access')) parts.push(`access:${form.get('access')}`);
  if (form.get('text').trim()) parts.push(`(${form.get('text').trim()})`);
  return { q: parts.join(' AND '), types: new Set(types.map((type) => type.toLowerCase())) };
}

async function scan() {
  const { q, types } = buildQuery(new FormData($('filters')));
  if (!types.size) return status('Choose at least one item type.');
  Object.assign(state, { results: [], unread: [], scanned: 0, stop: false });
  $('results').replaceChildren();
  $('scan').disabled = true;
  $('stop').disabled = false;
  const progress = () => status(`Scanned ${count(state.scanned, 'item')} — ${state.results.length} affected` +
    (state.unread.length ? `, ${state.unread.length} not fully read` : '') + (state.stop ? ' (stopping…)' : '…'));
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
      if (!types.has(item.type.toLowerCase())) continue;   // search matches words, so "Web Map" also finds "Web Mapping Application"
      batch.push(item);
      if (batch.length >= 60) await flush();
    }
    await flush();
    status(`${state.stop ? 'Stopped' : 'Done'}: ${count(state.scanned, 'item')} scanned, ${state.results.length} affected` +
      (state.unread.length ? `, ${state.unread.length} not fully read (listed below; not confirmed clean)` : '') + '.');
  } catch (error) {
    status('Scan failed: ' + error.message);
  }
  $('scan').disabled = false;
  $('stop').disabled = true;
  renderSummary();
}

async function scanItem(item) {
  const documents = [{ name: 'item URL', doc: { url: item.url || '' } }];
  const unread = (reason) => state.unread.push({ item, reason });
  try {
    const body = await itemBytes(item.id, state.session.token);
    if (body.tooLarge) {
      unread(`item data is ${Math.round(body.tooLarge / 1048576)} MB, over the ${DATA_LIMIT / 1048576} MB read limit`);
    } else {
      const content = await readContent(body.bytes);
      for (const entry of content.documents) documents.push({ name: entry.name, text: entry.text, doc: parse(entry.text) });
      if (content.unread) unread(content.unread);
    }
    if (RESOURCE_TYPES.has(item.type)) {
      const resources = await jsonResources(item.id, state.session.token);
      for (const entry of resources.documents) documents.push({ name: entry.name, doc: parse(entry.text) });
      if (resources.skipped) unread(`${count(resources.skipped, 'resource file')} beyond the first ${resources.limit} not read`);
    }
  } catch (error) {
    unread(error.message);
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
  const unread = state.unread.length ? h('details', {}, h('summary', {}, `${count(state.unread.length, 'item')} could not be fully read`),
    h('ul', {}, state.unread.map(({ item, reason }) => h('li', {}, itemLink(item.id, item.title), ` — ${reason}`)))) : null;
  $('results').prepend(h('div', { class: 'summary' },
    h('strong', {}, count(state.results.length, 'affected item')),
    state.results.length ? h('button', { onclick: exportCsv }, 'Export CSV') : null), unread || '');
}

const dataDocument = (result) => result.locations.find((location) => location.document.name === 'data')?.document;
const readySwaps = (result) => result.locations.filter((location) => location.ready);

function renderItem(result) {
  const { item } = result;
  const list = h('div');
  const note = h('span');
  const fixable = FIXABLE_TYPES.has(item.type);
  const all = h('button', { hidden: true, onclick: () => save(result, readySwaps(result).map((location) => ({ location, ...location.ready() }))) });
  const undo = h('button', { hidden: true, onclick: () => restore(result, result.backup.text, 'the backup taken before the first swap', note) }, 'Undo: restore the backup');
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  file.addEventListener('change', async () => {
    const [chosen] = file.files;
    file.value = '';
    if (chosen) restore(result, await chosen.text(), `the file "${chosen.name}"`, note, chosen.name);
  });
  const details = h('details', { class: 'item' },
    h('summary', {},
      h('span', { class: 'title' }, item.title),
      h('span', { class: 'meta' }, `${item.type} · ${item.owner} · ${item.access} · ${count(result.locations.length, 'reference')}`)),
    h('div', { class: 'location' },
      h('div', { class: 'action' }, itemLink(item.id, 'Open item page'), all, undo,
        fixable ? h('button', { onclick: () => file.click() }, 'Restore from a backup file…') : null, file),
      note),
    list);
  result.fill = () => list.replaceChildren(...result.locations.map((location) => renderLocation(result, location)));
  result.refresh = () => {
    const ready = readySwaps(result).length;
    all.hidden = ready < 2;
    all.textContent = `Apply all ${ready} swaps that are ready`;
    undo.hidden = !result.backup || !dataDocument(result) || result.backup.text === dataDocument(result).text;
  };
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.filled) return;
    details.dataset.filled = '1';
    result.fill();
  });
  return details;
}

function describe(location) {
  const names = location.candidates.slice(0, 3).flatMap((entry, index) => [index ? ', ' : '', itemLink(entry.id, entry.title)]);
  const more = location.candidates.length > 3 ? ` and ${location.candidates.length - 3} more` : '';
  return location.retiring ? ['Retiring: ', ...names]
    : [`One of ${location.candidates.length} retiring items sharing this service: `, ...names, more];
}

/** Title plus a warning when the item is itself on its way out. */
function targetLabel(item) {
  const superseded = item.deprecated || item.newVersionId;
  return item.title + (superseded ? ` — also deprecated${item.retires ? `, retires ${item.retires}` : ''}` : '');
}

/** A retirement notice can point to "a similar item" where there is no one-to-one replacement. */
function similarNote(id) {
  const similar = state.lookup.items.get(id)?.similarId;
  if (!similar) return '';
  const item = state.lookup.items.get(similar);
  return ` Its retirement notice points to a similar item instead of a one-to-one replacement: ${item ? item.title : 'not public'} (${similar}). Read the notice before switching.`;
}

function renderLocation(result, location) {
  const node = typeof location.document.doc === 'object' ? nodeAt(location.document.doc, location.path) : null;
  const body = h('div', { class: 'body' });
  const row = h('div', { class: 'location' },
    h('div', {}, node && node.title ? h('strong', {}, node.title + ' ') : null,
      h('code', {}, `${location.document.name} ${pointer(location.path)}`)),
    h('div', {}, describe(location)),
    body);

  if (location.document.name !== 'data' || !FIXABLE_TYPES.has(result.item.type)) {
    location.status = replacementNote(location) + ' This location is reported only; fix it in the item\'s own editor.';
    body.append(location.status);
    return row;
  }
  // The direct replacement may itself be deprecated; let the user step to it or jump to the latest.
  const chain = replacementChain(location.candidates[0], state.lookup);
  const show = (target, chosen = false) => body.replaceChildren(...renderSwap(result, location, node, target, target === chain[0], chosen));
  if (chain.length > 1) {
    const step = (index) => (index === chain.length - 1 ? 'Latest version' : index === 0 ? 'Next version' : 'Later version');
    const select = h('select', {}, chain.map((item, index) => h('option', {}, `${step(index)}: ${targetLabel(item)}`)));
    select.addEventListener('change', () => show(chain[select.selectedIndex]));
    row.insertBefore(h('label', {}, 'Replace with ', select), body);
  }
  show(chain[0]);
  row.append(ownChoice(show));
  return row;
}

/** Let the user name a replacement item themselves; it gets the same checks as a listed one. */
function ownChoice(show) {
  const input = h('input', { type: 'text', placeholder: 'item ID or item page address' });
  const message = h('span', { class: 'bad' });
  const check = async () => {
    const id = (input.value.toLowerCase().match(/[0-9a-f]{32}/) || [])[0];
    if (!id) return message.replaceChildren('That does not contain an item ID.');
    message.replaceChildren('');
    try {
      show(state.lookup.items.get(id) || await itemMeta(id, state.session.token), true);
    } catch (error) {
      message.replaceChildren(`That item could not be read (${error.message}).`);
    }
  };
  return h('details', {}, h('summary', { class: 'meta' }, 'Use a different replacement item'),
    h('div', { class: 'action' }, input, h('button', { onclick: check }, 'Check it'), message));
}

const shown = (value) => (typeof value === 'string' ? value : value === undefined ? '(not set)' : JSON.stringify(value));
const describeChange = (change) => `${change.key}: ${change.note || `${shown(change.from)} → ${shown(change.to)}`}`;

/**
 * A layer takes settings it does not set itself from the item it was added from. When a swap
 * changes only that item, write the old item's rendering rule into the layer so it keeps
 * drawing the same way.
 */
async function keepInherited(plan, location, node) {
  if (!location.retiring || node.renderingRule !== undefined) return;
  const data = parse(await itemData(location.retiring.id, state.session.token));
  if (data && data.renderingRule !== undefined) {
    plan.changes.push({ key: 'renderingRule', from: undefined, to: data.renderingRule });
  }
}

function renderSwap(result, location, node, target, direct, chosen) {
  const run = (location.run = {});   // a later choice in the version picker supersedes this one
  location.ready = null;
  result.refresh();
  const action = h('div', { class: 'action' });
  const plan = planSwap(location, node, state.lookup, target, chosen);
  location.status = plan.fixable ? 'Swap possible, schema not checked' : plan.reason;
  if (!plan.fixable) {
    action.append(plan.reason, chosen ? '' : similarNote(location.candidates[0].id));
    return [action];
  }
  const superseded = plan.replacement.deprecated || plan.replacement.newVersionId;
  const changeBox = h('div', { class: 'change' });
  const showChanges = () => changeBox.replaceChildren(...plan.changes.map((change) => h('div', {}, describeChange(change))));
  const checks = h('div', { class: 'checks' });
  const parts = [
    h('div', {}, 'Replacement: ', itemLink(plan.replacement.id, plan.replacement.title),
      chosen ? ' — chosen by you, not listed by Esri.' : direct ? sourceNote(location.candidates[0]) : ''),
    superseded ? h('div', { class: 'bad' }, `This replacement is itself deprecated${plan.replacement.retires ? ` and retires ${plan.replacement.retires}` : ''}.`) : null,
    similarNote(plan.replacement.id) ? h('div', {}, similarNote(plan.replacement.id).trim()) : null,
    changeBox,
    checks,
    action,
  ].filter(Boolean);
  showChanges();
  action.append(plan.sameService ? 'Reading the retiring item…' : 'Comparing schemas…');
  const check = plan.sameService
    ? keepInherited(plan, location, node).then(() => { showChanges(); return { same: true, blocking: [], fields: [] }; })
    : schemaCheck(plan.oldUrl, plan.newUrl, state.session.token);
  check.then((schema) => {
    if (location.run !== run) return;
    if (schema.blocking.length) {
      location.status = 'Not compatible: ' + schema.blocking.join('; ');
      action.replaceChildren(h('div', {}, h('span', { class: 'bad' }, 'Not compatible — not offered as a swap.'),
        h('ul', { class: 'problems' }, schema.blocking.slice(0, 8).map((problem) => h('li', {}, problem)),
          schema.blocking.length > 8 ? h('li', {}, `…and ${schema.blocking.length - 8} more`) : null)));
      return;
    }
    // A missing or retyped field matters only where this layer's own settings use it.
    const used = schema.fields.map((field) => ({ field, uses: fieldUses(node, field.name) }));
    const unused = used.filter((entry) => !entry.uses.length).map((entry) => entry.field.name);
    const retyped = used.filter((entry) => entry.uses.length && entry.field.issue === 'type');
    const missing = used.filter((entry) => entry.uses.length && entry.field.issue === 'missing');
    const selects = missing.map(({ field }) => fieldPicker(field));
    checks.replaceChildren(
      unused.length ? h('div', {}, `Not in the replacement, or a different type there, but not used by this layer's own settings: ${unused.join(', ')}. ` +
        'Anything outside this item that uses them (apps, Arcade in other items) is not checked.') : '',
      ...retyped.map(({ field, uses }) => h('div', { class: 'bad' },
        `Field ${field.name} is used by this layer's ${describeUses(uses)} and changes type (${field.old.type} to ${field.now.type}). Check the layer after swapping.`)),
      ...missing.map(({ field, uses }, index) => h('div', { class: 'action' },
        h('span', { class: 'bad' }, `Field ${field.name} (“${field.old.alias}”, ${field.old.type}) is used by this layer's ${describeUses(uses)} and is not in the replacement.`),
        h('label', {}, 'Use instead ', selects[index].select), selects[index].compare, selects[index].values)));

    // Renaming is on by default, except when only the item changes and the layer is otherwise the same.
    const rename = h('input', { type: 'checkbox', checked: !plan.sameService });
    const title = h('input', { type: 'text', value: plan.replacement.title || '' });
    const button = h('button', {}, 'Apply swap');
    const changes = () => {
      const list = [...plan.changes];
      const mapping = Object.fromEntries(missing.map(({ field }, index) => [field.name, selects[index].select.value]).filter(([, to]) => to !== KEEP));
      const renamed = renameFields(node, mapping);
      for (const key of Object.keys(node)) {
        if (['url', 'itemId', 'title'].includes(key) || JSON.stringify(node[key]) === JSON.stringify(renamed[key])) continue;
        const fields = Object.entries(mapping).filter(([from]) => fieldUses({ [key]: node[key] }, from).length);
        list.push({ key, from: node[key], to: renamed[key], note: fields.map(([from, to]) => `field ${from} → ${to}`).join(', ') });
      }
      if (rename.checked && title.value !== node.title) list.push({ key: 'title', from: node.title, to: title.value });
      return list;
    };
    const update = () => {
      const decided = selects.every(({ select }) => select.value);
      button.disabled = !decided;
      location.ready = decided && !location.done ? () => ({ changes: changes(), action }) : null;
      result.refresh();
    };
    selects.forEach(({ select }) => select.addEventListener('change', update));
    button.addEventListener('click', () => save(result, [{ location, changes: changes(), action }]));
    const clean = !schema.fields.length;
    location.status = clean ? 'Same schema; swap offered' : 'Schema differs; swap offered with caveats: ' + schema.problems.join('; ');
    action.replaceChildren(
      h('span', { class: 'good' }, plan.sameService ? 'Same service; the layer keeps its URL.' : clean ? 'Same schema.' : 'Schema differs; see above.'),
      h('label', {}, rename, node.title ? ` Rename layer "${node.title}" to` : ' Name the layer'), title, button);
    update();
  }).catch((error) => {
    if (location.run !== run) return;
    location.status = 'Schema could not be compared: ' + error.message;
    action.replaceChildren(h('span', { class: 'bad' }, `Schema could not be compared (${error.message}) — not offered as a swap.`));
  });
  return parts;
}

const KEEP = '(keep)';

/**
 * A choice of replacement field for one the layer uses and the new service lacks. A field with
 * the same alias and type is preselected; anything else is left for the user to decide.
 */
function fieldPicker(field) {
  const same = (option) => option.alias.toLowerCase() === field.old.alias.toLowerCase();
  const sure = field.options.filter((option) => same(option) && option.type === field.old.type);
  const select = h('select', {},
    h('option', { value: '' }, 'Choose…'),
    field.options.map((option) => h('option', { value: option.name, selected: sure.length === 1 && option === sure[0] },
      `${option.name} — “${option.alias}”, ${option.type}${same(option) ? ' (same alias)' : ''}`)),
    h('option', { value: KEEP }, 'Nothing: leave the layer naming the old field (that setting will stop working)'));
  const values = h('span', { class: 'meta' });
  const list = (rows) => rows.map((row) => `${row.value === null || String(row.value).trim() === '' ? '(blank)' : row.value} ×${Number(row.count).toLocaleString()}`).join(', ') || '(no rows)';
  const compare = h('button', {}, 'Compare values');
  compare.addEventListener('click', async () => {
    const to = select.value && select.value !== KEEP ? select.value : null;
    values.replaceChildren('Reading…');
    try {
      const token = state.session.token;
      const [before, after] = await Promise.all([
        topValues(field.oldLayer, field.name, field.oldOid, token), to ? topValues(field.newLayer, to, field.newOid, token) : null]);
      values.replaceChildren(`Most common values — ${field.name}: ${list(before)}` + (after ? `. ${to}: ${list(after)}` : '. Choose a field to compare it with.'));
    } catch (error) {
      values.replaceChildren(`Values could not be read (${error.message}).`);
    }
  });
  return { select, compare, values };
}

/** Say where the replacement came from when it is not simply the table's. */
function sourceNote(entry) {
  if (entry.replacementSource === 'suggestion') {
    return ` — suggested by this tool, not by Esri (the table says "${entry.tableText}"). ${entry.suggestionNote}`;
  }
  if (entry.replacementSource === 'description') {
    return ` — taken from the "new version" link in the retiring item's description; Esri's table says "${entry.tableText}".`;
  }
  return entry.alternateId ? ` — taken from Esri's table; the item linked in the description (${entry.alternateId}) could not be read.` : '';
}

function replacementNote(location) {
  const entry = location.candidates[0];
  if (!entry.replacementIds.length) return entry.replacementNote + '.' + similarNote(entry.id);
  const chain = replacementChain(entry, state.lookup);
  const latest = chain.length > 1 ? ` Latest version: ${chain.at(-1).title} (${chain.at(-1).id}).` : '';
  return `Replacement: ${chain[0] ? targetLabel(chain[0]) : entry.replacementIds[0]} (${entry.replacementIds.join(', ')})${sourceNote(entry) || '.'}${latest}${similarNote(entry.replacementIds[0])}`;
}

// ---- Save swaps, undo ---------------------------------------------------------------------

const backupName = (item, label = 'before') => `${item.id}-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

/** Apply one or more planned swaps to an item in a single save. entries: [{ location, changes, action }]. */
async function save(result, entries) {
  const { item } = result;
  const document = entries[0].location.document;
  const layerName = (location) => nodeAt(document.doc, location.path)?.title || pointer(location.path);
  const summary = entries.map((entry) => (entries.length > 1 ? `${layerName(entry.location)}\n` : '') + entry.changes.map(describeChange).join('\n')).join('\n\n');
  const backup = result.backup ? `The backup downloaded earlier (${result.backup.name}) still holds the item as it was before the first swap.`
    : 'A copy of the current item data is downloaded first.';
  if (!confirm(`Save ${count(entries.length, 'swap')} to "${item.title}"?\n\n${summary}\n\n${backup}`)) return;
  const each = (fn) => entries.forEach(fn);
  each((entry) => entry.action.replaceChildren('Saving…'));
  try {
    const token = state.session.token;
    const current = await itemData(item.id, token);
    if (current !== document.text) throw new Error('The item changed since the scan. Scan again before fixing it.');
    if (/[:\[,]\s*-?\d{16,}/.test(current)) throw new Error('The item data holds numbers too large to rewrite safely in a browser. Fix it by hand.');
    if (!result.backup) {
      result.backup = { text: current, name: backupName(item) };
      download(result.backup.name, current);
    }
    const next = entries.reduce((doc, entry) => applySwap(doc, entry.location.path, entry.changes), document.doc);
    await updateItemData(item, JSON.stringify(next), token);
    const savedText = await itemData(item.id, token);
    const savedDoc = JSON.parse(savedText);
    const wrong = entries.flatMap((entry) => {
      const saved = nodeAt(savedDoc, entry.location.path) || {};
      return entry.changes.filter((change) => JSON.stringify(saved[change.key]) !== JSON.stringify(change.to)).map((change) => change.key);
    });
    if (wrong.length) throw new Error(`Saved, but reading the item back did not show: ${wrong.join(', ')}. Check the item.`);
    Object.assign(document, { text: savedText, doc: savedDoc });
    each((entry) => {
      Object.assign(entry.location, { status: 'Fixed and read back', ready: null, done: true });
      entry.action.replaceChildren(h('span', { class: 'good' }, 'Saved and read back. Open the item to confirm it draws correctly.'));
    });
  } catch (error) {
    each((entry) => {
      Object.assign(entry.location, { status: 'Apply failed: ' + error.message, ready: null });
      entry.action.replaceChildren(h('span', { class: 'bad' }, error.message));
    });
  }
  result.refresh();
}

/** Put back an earlier copy of the item data: the backup held in memory, or a downloaded backup file. */
async function restore(result, text, label, note, fileName) {
  const { item } = result;
  const say = (message, good) => note.replaceChildren(h('span', { class: good ? 'good' : 'bad' }, message));
  try {
    const wanted = JSON.parse(text);
    if (!wanted || typeof wanted !== 'object' || Array.isArray(wanted)) throw new Error('not item data');
    const odd = fileName && !fileName.startsWith(item.id) ? `\n\nThe file name does not start with this item's ID (${item.id}). Make sure it is a backup of this item.` : '';
    if (!confirm(`Replace the data of "${item.title}" with ${label}?\n\nEvery change made to the item since then is lost, including changes made outside this tool.${odd}`)) return;
    const token = state.session.token;
    const document = dataDocument(result);
    const current = await itemData(item.id, token);
    // Keep a copy of anything this tool does not already hold before overwriting it.
    if (current !== result.backup?.text && (fileName || current !== document?.text)) download(backupName(item, 'before-restore'), current);
    await updateItemData(item, text, token);
    const savedText = await itemData(item.id, token);
    if (JSON.stringify(JSON.parse(savedText)) !== JSON.stringify(wanted)) throw new Error('Saved, but reading the item back did not match the backup. Check the item.');
    // Start over on this item: its references are whatever the restored data holds.
    const restored = { name: 'data', text: savedText, doc: JSON.parse(savedText) };
    result.locations = [
      ...result.locations.filter((location) => location.document.name !== 'data'),
      ...findReferences(restored.doc, state.lookup).map((location) => ({ ...location, document: restored })),
    ];
    result.fill();
    result.refresh();
    say('Restored and read back. Open the item to confirm it draws correctly.', true);
  } catch (error) {
    say(`Not restored: ${error.message}`);
  }
}

function download(name, text, type = 'application/json') {
  const link = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

function exportCsv() {
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [['item_id', 'title', 'type', 'owner', 'sharing', 'document', 'location', 'retiring_ids', 'retiring_titles', 'replacement_ids', 'replacement_source', 'latest_version_id', 'status']];
  for (const { item, locations } of state.results) {
    for (const location of locations) {
      rows.push([item.id, item.title, item.type, item.owner, item.access, location.document.name, pointer(location.path),
        location.candidates.map((entry) => entry.id).join(' '), location.candidates.map((entry) => entry.title).join(' | '),
        [...new Set(location.candidates.flatMap((entry) => entry.replacementIds))].join(' '),
        [...new Set(location.candidates.filter((entry) => entry.replacementIds.length).map((entry) => entry.replacementSource))].join(' '),
        replacementChain(location.candidates[0], state.lookup).at(-1)?.id || '',
        location.status || 'Not opened']);
    }
  }
  download('retiring-item-references.csv', rows.map((row) => row.map(cell).join(',')).join('\r\n'), 'text/csv');
}

start().catch((error) => status('Could not start: ' + error.message));
