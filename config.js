// The OAuth client ID is a public identifier, not a secret. Register the app's page URL
// (for example https://<account>.github.io/<repo>/) as a redirect URL on the same credentials.
export const CLIENT_ID = 'qlvvVdbropzlbXdn';
export const PORTAL = 'https://www.arcgis.com';
export const RETIREMENT_TABLE =
  'https://P3ePLMYs2RVChkJx.svcs.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/Esri_Items_Retiring_in_December_2026/FeatureServer/0';

// Corrections to "new version" links in Esri item descriptions: item ID -> the item it should link to.
// Remove an entry once the description is fixed.
export const LINK_FIXES = {
  // United States County Boundaries: its retirement notice links the Country item (508e141c...).
  '36a7fa832aea4b7e8266a8d983afa4ac': '12f0d81d2d664af7b9961d316ce26556',
};
