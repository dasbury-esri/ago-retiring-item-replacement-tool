// Run with: node --test app/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serviceParts, parseReplacement, newVersionLink, buildLookup, findReferences, planSwap, applySwap, compareSchemas, nodeAt,
} from '../match.js';

const OLD = 'a'.repeat(32), NEW = 'b'.repeat(32), TWIN = 'c'.repeat(32), GONE = 'd'.repeat(32);
const OLD_URL = 'https://services.arcgis.com/Org/arcgis/rest/services/States/FeatureServer';
const NEW_URL = 'https://services.arcgis.com/Org/arcgis/rest/services/States_2023/FeatureServer';
const SHARED = 'https://demographics5.arcgis.com/arcgis/rest/services/USA/MapServer';

const lookup = buildLookup(
  [
    { item_id: OLD, title: 'States', item_type: 'Feature Service', superceded_by: NEW },
    { item_id: TWIN, title: 'Income', item_type: 'Map Service', superceded_by: 'No replacement item' },
    { item_id: GONE, title: 'Age', item_type: 'Map Service', superceded_by: 'Coming soon' },
  ],
  new Map([
    [OLD, { id: OLD, url: OLD_URL }],
    [NEW, { id: NEW, url: NEW_URL + '/', title: 'States 2023' }],
    [TWIN, { id: TWIN, url: SHARED + '?ts=1' }],
    [GONE, { id: GONE, url: SHARED }],
  ]),
);

const webMap = () => ({
  operationalLayers: [
    { id: 'keep-me', title: 'Other', url: 'https://example.com/arcgis/rest/services/X/FeatureServer/0' },
    { id: 'group', layerType: 'GroupLayer', layers: [
      { id: 'layer-1', title: 'States', itemId: OLD, url: OLD_URL.replace('https', 'http').toUpperCase().replace('HTTP', 'http') + '/2', opacity: 0.5 },
    ] },
    { id: 'layer-2', url: SHARED + '/4' },
  ],
});

test('service URLs split into key, root and layer', () => {
  const parts = serviceParts(OLD_URL + '/2?token=x');
  assert.equal(parts.key, 'services.arcgis.com/org/arcgis/rest/services/states/featureserver');
  assert.equal(parts.root, OLD_URL);
  assert.equal(parts.layer, 2);
  assert.equal(serviceParts(SHARED).layer, null);
  assert.equal(serviceParts('https://example.com/page'), null);
});

test('replacement column is an ID, several IDs, or prose', () => {
  assert.deepEqual(parseReplacement(NEW).ids, [NEW]);
  assert.equal(parseReplacement(`${NEW}, ${OLD}`).ids.length, 2);
  assert.equal(parseReplacement('No replacement item').note, 'No replacement item');
});

test('finds nested layers; ID resolves, shared URL stays ambiguous', () => {
  const found = findReferences(webMap(), lookup);
  assert.equal(found.length, 2);
  const [nested, shared] = found;
  assert.deepEqual(nested.path, ['operationalLayers', '1', 'layers', '0']);
  assert.equal(nested.retiring.id, OLD);
  assert.equal(shared.retiring, null);
  assert.deepEqual(shared.candidates.map((entry) => entry.id).sort(), [TWIN, GONE].sort());
});

test('finds references in plain text', () => {
  const found = findReferences(`see https://www.arcgis.com/home/item.html?id=${OLD}`, lookup);
  assert.equal(found[0].retiring.id, OLD);
});

test('swap changes only url and itemId, keeps the layer index', () => {
  const doc = webMap();
  const [nested, shared] = findReferences(doc, lookup);
  const plan = planSwap(nested, nodeAt(doc, nested.path), lookup);
  assert.equal(plan.fixable, true);
  assert.equal(plan.newUrl, NEW_URL + '/2');
  const fixed = applySwap(doc, nested.path, plan.changes);
  const expected = webMap();
  expected.operationalLayers[1].layers[0].url = NEW_URL + '/2';
  expected.operationalLayers[1].layers[0].itemId = NEW;
  assert.deepEqual(fixed, expected);
  assert.deepEqual(doc, webMap(), 'original is untouched');
  assert.equal(planSwap(shared, nodeAt(doc, shared.path), lookup).fixable, false);
});

test('swap refuses a different service type', () => {
  const other = buildLookup(
    [{ item_id: OLD, superceded_by: NEW }],
    new Map([[OLD, { id: OLD, url: SHARED }], [NEW, { id: NEW, url: NEW_URL }]]),
  );
  const doc = { layers: [{ url: SHARED }] };
  const [location] = findReferences(doc, other);
  assert.match(planSwap(location, nodeAt(doc, location.path), other).reason, /Service type changes/);
});

test('self-replacement is not a swap; same-service replacement changes only the item ID', () => {
  const quirks = buildLookup(
    [{ item_id: OLD, superceded_by: OLD }, { item_id: TWIN, superceded_by: NEW }],
    new Map([[OLD, { id: OLD, url: OLD_URL }], [TWIN, { id: TWIN, url: NEW_URL }], [NEW, { id: NEW, url: NEW_URL }]]),
  );
  const doc = { layers: [{ itemId: OLD, url: OLD_URL }, { itemId: TWIN, url: NEW_URL + '/1' }, { itemId: NEW, url: NEW_URL }] };
  const [self, twin, already] = findReferences(doc, quirks).map((location) => planSwap(location, nodeAt(doc, location.path), quirks));
  assert.match(self.reason, /its own replacement/);
  assert.deepEqual(twin.changes, [{ key: 'itemId', from: TWIN, to: NEW }]);
  assert.match(already.reason, /already points at the replacement/);
});

test('description link wins unless only the table\'s replacement can be read', () => {
  const notice = (id) => `<p><strong>Retirement Notice:</strong> A <a target='_blank' href='https://www.arcgis.com/home/item.html?id=${id}'><strong>new version of this item</strong></a> is available. See <a href='https://www.arcgis.com/home/item.html?id=${GONE}'>related data</a>.</p>`;
  assert.equal(newVersionLink(notice(NEW), OLD), NEW);
  assert.equal(newVersionLink(notice(OLD), OLD), null);
  assert.equal(newVersionLink('no links here', OLD), null);
  const filled = buildLookup(
    [{ item_id: OLD, superceded_by: 'Coming soon' }, { item_id: TWIN, superceded_by: TWIN }, { item_id: GONE, superceded_by: OLD }],
    new Map([[OLD, { newVersionId: NEW }], [TWIN, { newVersionId: NEW }], [GONE, { newVersionId: NEW }]]),
  );
  assert.deepEqual([filled.byId.get(OLD).replacementIds, filled.byId.get(OLD).replacementSource], [[NEW], 'description']);
  assert.deepEqual(filled.byId.get(TWIN).replacementIds, [NEW]);
  assert.deepEqual([filled.byId.get(GONE).replacementIds, filled.byId.get(GONE).replacementSource, filled.byId.get(GONE).alternateId], [[OLD], 'table', NEW]);
  const readable = (source) => new Map([[OLD, { newVersionId: NEW }], [NEW, {}], ...source]);
  const disagree = buildLookup([{ item_id: OLD, superceded_by: GONE }], readable([[GONE, {}]])).byId.get(OLD);
  assert.deepEqual([disagree.replacementIds, disagree.replacementSource, disagree.alternateId], [[NEW], 'description', GONE]);
  const agree = buildLookup([{ item_id: OLD, superceded_by: NEW }], readable([])).byId.get(OLD);
  assert.deepEqual([agree.replacementIds, agree.replacementSource, agree.alternateId], [[NEW], 'table', null]);
});

test('schema comparison', () => {
  const field = (name, type = 'esriFieldTypeString') => ({ name, type });
  const old = { geometryType: 'esriGeometryPolygon', fields: [field('NAME'), field('POP', 'esriFieldTypeInteger')] };
  const same = { geometryType: 'esriGeometryPolygon', fields: [field('name'), field('POP', 'esriFieldTypeInteger'), field('EXTRA')] };
  assert.equal(compareSchemas(old, same).same, true);
  assert.equal(compareSchemas(old, { ...same, fields: [field('NAME')] }).problems.length, 1);
  assert.equal(compareSchemas(old, { ...same, geometryType: 'esriGeometryPoint' }).same, false);
  assert.equal(compareSchemas({ layers: [{ id: 0, name: 'A', ...old }] }, { layers: [{ id: 1, name: 'A', ...same }] }).same, false);
  assert.equal(compareSchemas({}, {}).same, false);
});
