// The OAuth client ID is a public identifier, not a secret. Register the app's page URL
// (for example https://<account>.github.io/<repo>/) as a redirect URL on the same credentials.
export const CLIENT_ID = 'qlvvVdbropzlbXdn';
export const PORTAL = 'https://www.arcgis.com';
export const RETIREMENT_TABLE =
  'https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Esri_Items_Retiring_in_December_2026/FeatureServer/0';

// Corrections to "new version" links in Esri item descriptions: item ID -> the item it should
// link to (or null to ignore a wrong link when the right item is not known).
// Remove an entry once the description is fixed.
export const LINK_FIXES = {
  // United States County Boundaries: its retirement notice links the Country item (508e141c...).
  '36a7fa832aea4b7e8266a8d983afa4ac': '12f0d81d2d664af7b9961d316ce26556',
  // World Linear Water [Layer Package]: its notice links "USA States".
  '273980c20bc74f94ac96c7892ec15aff': 'c63ed789019a4e6a9ce948621371c7bc',
  // USA ZIP Code Areas [Layer Package]: its notice links "Armenia Marzer Boundaries".
  '8d2012a2016e484dafaac0451f9aea24': '91c6859151e84a2eacb0cfb1e38466ca',
};

// Corrections to a replacement item's service address, where the address stored in the item
// does not answer: item ID -> { url, note }. The swap writes this address into the layer and the
// tool says so. Remove an entry once the item is fixed.
export const URL_FIXES = {
  // Above and below ground biomass carbon (replaces World Biomass): the item's address answers
  // "No proxy information found". Checked 13 November 2026.
  'f797683411784e73975736cf4d1f3f22': {
    url: 'https://data-gis.unep-wcmc.org/server/rest/services/Hosted/world_biomass_carbon/ImageServer',
    note: 'The service address stored in this item does not answer ("No proxy information found"). ' +
      'This tool uses the address that UNEP-WCMC\'s own portal now gives for the same dataset instead.',
  },
};

// Replacements that neither Esri's table nor the items' retirement notices give. They are this
// tool's suggestions and are labelled as such: retiring item ID -> { id, note }.
const SENTINEL_VIEWS = {
  id: 'fd61b9e0c69c4e14bebd50a9a968348c',
  note: 'Sentinel-2 Views is a current item on the same image service, which offers this rendering as a ' +
    'processing template, so the layer keeps its URL and rendering. Sentinel-2 Level-2A ' +
    '(255af1ceee844d6da8ef8440c8f90d00) is an alternative with atmospheric correction and the full archive, ' +
    'but it is a different service with different bands and needs a subscription, so it is not a drop-in swap.',
};
export const SUGGESTIONS = Object.fromEntries([
  '112db40d3640473aacb0d1f891462496', '1e5fe250cdb8444c9d8b16bb14bd1140', '1f650908c00c42338aa3da3d654dfe59',
  '2658178ff00e440aae303452bfcec6cf', '3cf4e98f035e47279091dc74d43392a5', '41c1069f84eb40ff90940c0299f31c77',
  '5cbafcf777e845129771e601701aaae7', '5ff454d2e9ea420ba1f810076ce70ec2', '69478c5dc15a4b128d36de858602e275',
  '807d13b07c95425a99b9559d7c6d8579', '972c8f73028a4a358160e449d458bdf7', 'b9701ce2f0184c058ad132d28f0495b9',
  'c9fe8496820442c08a531fb20c0cded6', 'd74d10dc48444cf5bbbc48faecd65442', 'dccafe125bbe4e2bb3315393acbd4701',
].map((id) => [id, SENTINEL_VIEWS]));   // the 15 "Sentinel-2 Imagery: <rendering>" items
