// How item types are grouped in the type picker, and which are left out of a scan.
//
// The scanner does not rely on this list to know how to read an item: it looks at the bytes
// the item's data endpoint returns (JSON, other text, zip, or something it cannot open) and
// reads whatever is readable. The groups below come from probing public items of each type
// in November 2026; a type missing from this file is still scanned, under "Other types".

export const GROUPS = [
  {
    label: 'Maps and layers',
    note: 'item data',
    types: ['Web Map', 'Web Scene', 'Group Layer', 'Layer', 'Feature Collection', 'Media Layer', 'Map Area',
      'Oriented Imagery Catalog', 'Raster function template', 'Style'],
  },
  {
    label: 'Apps, stories and sites',
    note: 'item data, plus draft resources or zipped contents where the type has them',
    types: ['StoryMap', 'StoryMap Theme', 'Web Mapping Application', 'Dashboard', 'Operation View', 'Web Experience',
      'Web Experience Template', 'Hub Site Application', 'Hub Page', 'Hub Initiative', 'Insights Workbook',
      'Insights Page', 'Insights Theme', 'Notebook', 'Form', 'QuickCapture Project', 'Workforce Project', 'Solution',
      'Urban Model', 'Analysis Model', 'Data Pipeline', '360 VR Experience', 'SMX Item', 'SMX Theme'],
  },
  {
    label: 'Services and links',
    note: 'the item URL, plus item data when there is any',
    types: ['Feature Service', 'Map Service', 'Image Service', 'Vector Tile Service', 'Scene Service',
      'Geoprocessing Service', 'WMS', 'WMTS', 'WFS', 'KML', 'Document Link', 'Application', 'Mobile Application'],
  },
];

/** Types that also keep JSON in item resources (drafts, saved versions, project files). */
export const RESOURCE_TYPES = new Set(['StoryMap', 'Web Experience', 'Web Experience Template', 'QuickCapture Project']);

/** Types left out of a scan, with the reason shown to the user. */
export const NOT_SCANNED = [
  {
    reason: 'packaged in a format a browser cannot open (7z or a proprietary binary), so references inside cannot be read',
    types: ['CityEngine Web Scene', 'Service Definition', 'Map Package', 'Layer Package', 'Project Package',
      'Mobile Scene Package'],
  },
  {
    reason: 'data files and packages that carry their own data, not references to other items',
    types: ['CSV', 'CSV Collection', 'Shapefile', 'File Geodatabase', 'SQLite Geodatabase', 'GeoJson', 'Image',
      'Image Collection', 'PDF', 'Microsoft Excel', 'Microsoft Word', 'Microsoft Powerpoint', 'Tile Package',
      'Compact Tile Package', 'Vector Tile Package', 'Scene Package', 'Mobile Map Package', 'Desktop Style',
      'Desktop Application', 'Desktop Application Template', 'Native Application', 'Code Attachment', 'Code Sample',
      'Administrative Report', 'Report Template', 'API Key'],
  },
];

const key = (type) => String(type).toLowerCase();
const KNOWN = new Map([...GROUPS, ...NOT_SCANNED].flatMap((group) => group.types.map((type) => [key(type), type])));
const SKIPPED = new Set(NOT_SCANNED.flatMap((group) => group.types.map(key)));

/** Search reports type names in lower case; give back the usual spelling where it is known. */
export const typeName = (type) => KNOWN.get(key(type)) || type;
export const isKnownType = (type) => KNOWN.has(key(type));
export const isScanned = (type) => !SKIPPED.has(key(type));
