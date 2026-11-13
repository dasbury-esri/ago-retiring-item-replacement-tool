// Run with: node --test app/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serviceParts, parseReplacement, newVersionLink, retirementDate, replacementChain, buildLookup, findReferences, planSwap, applySwap, compareSchemas, nodeAt,
} from '../match.js';
import { readContent } from '../content.js';
import { describeUses, fieldUses, renameFields } from '../fields.js';

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
  // the third layer is already on the replacement item; its service survives, so it is not a reference
  const found = findReferences(doc, quirks);
  assert.equal(found.length, 2);
  const [self, twin] = found.map((location) => planSwap(location, nodeAt(doc, location.path), quirks));
  assert.match(self.reason, /its own replacement/);
  assert.deepEqual(twin.changes, [{ key: 'itemId', from: TWIN, to: NEW }]);
  // a suggestion fills in only where table and description give nothing
  const suggested = buildLookup([{ item_id: OLD, superceded_by: 'No replacement item' }, { item_id: TWIN, superceded_by: GONE }],
    new Map([[OLD, { url: OLD_URL }], [NEW, { id: NEW, url: OLD_URL }], [GONE, {}]]),
    { [OLD]: { id: NEW, note: 'why' }, [TWIN]: { id: NEW, note: 'unused' } });
  assert.deepEqual([suggested.byId.get(OLD).replacementIds, suggested.byId.get(OLD).replacementSource], [[NEW], 'suggestion']);
  assert.deepEqual([suggested.byId.get(TWIN).replacementIds, suggested.byId.get(TWIN).replacementSource], [[GONE], 'Esri replacement table']);
  assert.equal(suggested.byUrl.size, 0);
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
  assert.deepEqual([filled.byId.get(GONE).replacementIds, filled.byId.get(GONE).replacementSource, filled.byId.get(GONE).alternateId], [[OLD], 'Esri replacement table', NEW]);
  const readable = (source) => new Map([[OLD, { newVersionId: NEW }], [NEW, {}], ...source]);
  const disagree = buildLookup([{ item_id: OLD, superceded_by: GONE }], readable([[GONE, {}]])).byId.get(OLD);
  assert.deepEqual([disagree.replacementIds, disagree.replacementSource, disagree.alternateId], [[NEW], 'description', GONE]);
  const agree = buildLookup([{ item_id: OLD, superceded_by: NEW }], readable([])).byId.get(OLD);
  assert.deepEqual([agree.replacementIds, agree.replacementSource, agree.alternateId], [[NEW], 'Esri replacement table', null]);
});

test('a deprecated replacement leads on to its newer version, and either can be the swap target', () => {
  assert.equal(retirementDate('<p>in mature support and <b>will retire in December 2028</b>.</p>'), 'December 2028');
  assert.equal(retirementDate('This item will be retired in December 2026.'), 'December 2026');
  assert.equal(retirementDate('nothing'), null);
  const LATEST_URL = 'https://x.svcs.arcgis.com/Org/arcgis/rest/services/States_view/FeatureServer';
  const chained = buildLookup(
    [{ item_id: OLD, superceded_by: NEW }],
    new Map([[OLD, { id: OLD, url: OLD_URL }], [NEW, { id: NEW, url: NEW_URL, deprecated: true, newVersionId: TWIN }],
      [TWIN, { id: TWIN, url: LATEST_URL, newVersionId: OLD }]]),   // a loop back must not run forever
  );
  const chain = replacementChain(chained.byId.get(OLD), chained);
  assert.deepEqual(chain.map((item) => item.id), [NEW, TWIN]);
  const doc = { layers: [{ itemId: OLD, url: OLD_URL + '/3' }] };
  const [location] = findReferences(doc, chained);
  assert.equal(planSwap(location, nodeAt(doc, location.path), chained).newUrl, NEW_URL + '/3');
  const latest = planSwap(location, nodeAt(doc, location.path), chained, chain[1]);
  assert.deepEqual([latest.newUrl, latest.changes[1].to], [LATEST_URL + '/3', TWIN]);
});

test('item data is read by what it is: text, zip, or unreadable', async () => {
  const bytes = (text) => new TextEncoder().encode(text);
  assert.deepEqual(await readContent(bytes('')), { documents: [], unread: null });
  assert.equal((await readContent(bytes('\uFEFF{"a":1}'))).documents[0].text, '{"a":1}');
  assert.match((await readContent(Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c))).unread, /7z/);
  assert.match((await readContent(Uint8Array.of(1, 2, 0, 3))).unread, /binary/);
  // a one-file zip, stored uncompressed: local header, central directory, end record
  const name = bytes('a/config.json'), body = bytes('{"url":"x"}');
  const header = (signature, fields) => { const view = new DataView(new ArrayBuffer(fields)); view.setUint32(0, signature, true); return view; };
  const local = header(0x04034b50, 30); local.setUint32(18, body.length, true); local.setUint32(22, body.length, true); local.setUint16(26, name.length, true);
  const central = header(0x02014b50, 46); central.setUint32(20, body.length, true); central.setUint32(24, body.length, true); central.setUint16(28, name.length, true);
  const end = header(0x06054b50, 22); end.setUint16(10, 1, true); end.setUint32(16, 30 + name.length + body.length, true);
  const zip = new Uint8Array(await new Blob([local, name, body, central, name, end]).arrayBuffer());
  assert.deepEqual((await readContent(zip)).documents, [{ name: 'data.zip/a/config.json', text: '{"url":"x"}' }]);
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

test('schema differences are split into blocking ones and field ones', () => {
  const f = (name, type = 'esriFieldTypeString', alias = name) => ({ name, type, alias });
  const old = { geometryType: 'esriGeometryPolygon', fields: [f('FID', 'esriFieldTypeOID'), f('NAME'), f('FCC', undefined, 'Feature Code')] };
  const next = { geometryType: 'esriGeometryPolygon', fields: [f('OBJECTID', 'esriFieldTypeOID'), f('NAME', 'esriFieldTypeDouble'), f('MNFC', 'esriFieldTypeSmallInteger', 'Feature Code')] };
  const result = compareSchemas(old, next);
  assert.equal(result.same, false);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.fields.map((field) => [field.name, field.issue]), [['NAME', 'type'], ['FCC', 'missing']]);
  assert.deepEqual(result.fields[1].options.map((option) => option.name), ['NAME', 'MNFC']);
  assert.equal(result.fields[1].oldOid, 'FID');
  const image = { pixelType: 'F32', bandCount: 2, capabilities: 'Image' };
  assert.equal(compareSchemas(image, { ...image, capabilities: 'Image,TilesOnly' }).blocking.length, 1);
});

test('a replacement the user names skips the table but not the other checks', () => {
  const doc = { layers: [{ itemId: TWIN, url: SHARED + '/2' }] };
  const [location] = findReferences(doc, lookup);
  const node = nodeAt(doc, location.path);
  assert.equal(planSwap(location, node, lookup).fixable, false);
  const own = { id: 'e'.repeat(32), url: 'https://demographics9.arcgis.com/arcgis/rest/services/Other/MapServer' };
  assert.equal(planSwap(location, node, lookup, own, true).newUrl, own.url + '/2');
  assert.match(planSwap(location, node, lookup, { id: OLD, url: OLD_URL }, true).reason, /retirement list/);
  assert.match(planSwap(location, node, lookup, { id: own.id, url: NEW_URL }, true).reason, /Service type changes/);
});

test('field uses are found and renamed only where they are field names', () => {
  const node = {
    title: 'FCC layer', url: 'https://x/FCC/FeatureServer/0',
    layerDefinition: { definitionExpression: "FCC = 'FCC' AND NFCC > 1", drawingInfo: { renderer: { field1: 'fcc', label: 'FCC' },
      labelingInfo: [{ labelExpression: '[FCC]', labelExpressionInfo: { expression: '$feature.FCC + $feature["FCC"] + $feature.FCC2' } }] } },
    popupInfo: { title: '{FCC} of {NAME}', fieldInfos: [{ fieldName: 'FCC', visible: false }, { fieldName: 'FCC', visible: true }] },
    orderBy: { orderByFields: ['FCC DESC'] },
  };
  assert.equal(fieldUses(node, 'FCC').length, 7);
  assert.deepEqual(fieldUses(node, 'SQMI'), []);
  assert.equal(describeUses(fieldUses(node, 'FCC')), 'filter, drawing, labels, pop-up, orderBy/orderByFields/0');
  const renamed = renameFields(node, { FCC: 'MNFC' });
  assert.deepEqual(renamed, {
    title: 'FCC layer', url: 'https://x/FCC/FeatureServer/0',
    layerDefinition: { definitionExpression: "MNFC = 'FCC' AND NFCC > 1", drawingInfo: { renderer: { field1: 'MNFC', label: 'FCC' },
      labelingInfo: [{ labelExpression: '[MNFC]', labelExpressionInfo: { expression: '$feature.MNFC + $feature["MNFC"] + $feature.FCC2' } }] } },
    popupInfo: { title: '{MNFC} of {NAME}', fieldInfos: [{ fieldName: 'FCC', visible: false }, { fieldName: 'MNFC', visible: true }] },
    orderBy: { orderByFields: ['MNFC DESC'] },
  });
  assert.equal(node.popupInfo.title, '{FCC} of {NAME}');
});
