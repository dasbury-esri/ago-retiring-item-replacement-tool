# Retiring item replacement tool

A static browser app. No backend, no build step, no dependencies.

1. **Lookup** — reads Esri's public "Items Retiring in December 2026" table and resolves each
   retiring item (and its listed replacement) to a service URL. The "new version of this item"
   link in the retiring item's description is preferred over the table's replacement column when they differ or the table has none; the
   table's is used only when the description's item cannot be read and the table's can. The
   result says which source was used.
2. **Scan** — after ArcGIS sign-in, searches the signed-in user's items (the whole organization
   for an administrator) and reads each one for retiring item IDs and service URLs.
   Filters: owner (administrators), sharing level, item type, title/tag text.
3. **Fix** — for layers in a Web Map, Web Scene or Group Layer whose replacement is the same
   service type with a compatible schema, offers a swap of item ID and service URL, with an
   optional layer rename. Everything else is reported with its location and the listed replacement.

A replacement can itself be deprecated and link to a newer version. The tool says so, and where
a newer version exists it offers a choice between the next version and the latest; each choice
gets its own schema check.

For a few retiring items neither source gives a replacement but a current item on the same
service exists (the 15 "Sentinel-2 Imagery" renderings, now covered by Sentinel-2 Views). Those
suggestions live in `config.js` and are labelled in the results as the tool's own, not Esri's.

When a replacement item points at the same service as the retiring one, the service is not going
away: layers on it are flagged only if they name the retiring item by ID, and a swap changes the
item ID alone. Because a layer takes settings it does not set itself from the item it was added
from, such a swap also writes the old item's rendering rule into the layer so it draws as before.

## Where references are looked for

The scanner does not need to know each item type's storage format in advance. For every item it
checks the item URL, then downloads the item data and looks at what it actually is:

| The item data is | What happens |
| --- | --- |
| JSON or other text (web maps, scenes, apps, dashboards, notebooks, most types) | read in full |
| a zip file (Survey123 forms, 360 VR experiences, KMZ) | text files inside are read |
| a 7z archive or other binary | listed as not read |
| larger than 30 MB | not downloaded; listed as not read |

StoryMap, Web Experience, Web Experience Template and QuickCapture Project items also have their
JSON resources read (drafts and saved versions, up to 200 files).

The type picker lists only the item types that exist in the content being scanned, grouped by
kind, with counts. `types.js` holds the grouping and the types left out of a scan: data files and
packages that carry their own data (CSV, shapefile, tile packages, PDF, Office files and so on),
and formats a browser cannot open (service definitions, map, layer and project packages,
CityEngine web scenes). A type the file does not mention is still offered, under "Other types".

A retirement notice that links "a similar item" instead of a new version means there is no
one-to-one replacement. The tool shows that link as information and does not offer a swap to it.

Items that could not be read are listed after a scan; they are not confirmed clean.

## What the schema check decides

The retiring and replacement services are compared layer by layer (the ObjectID field is ignored;
extra fields in the replacement are fine).

- **Not offered:** a layer ID is missing, the geometry type differs, or for image services the
  pixel type, band count or data type differs, or one is tiled and the other dynamic.
- **Offered with a note:** a field is missing or has a different type, but the layer's own
  settings do not use it.
- **Offered with a warning:** a field the layer uses has a different type.
- **Offered once you decide:** a field the layer uses is missing. Choose a field to use instead,
  or choose to leave the old name in place. A field with the same alias and type is preselected.
  "Compare values" shows the five most common values of the old field and the chosen one.

`fields.js` lists exactly where a field name is recognised in a layer's settings (renderer and
other `…field…` keys, `{NAME}` in pop-up text, `$feature.NAME` in Arcade, `[NAME]` in label
expressions, and the bare word in `definitionExpression`). Field values are compared only when you
ask; drawing is never compared: open the item after a swap and look at it.

## Items that use an affected item

A web map can be used by a story, dashboard or other app, and that app can filter or style the
map's layers itself. While scanning, the tool notes every item ID each scanned item mentions.
An affected item then lists the scanned items that mention it, directly or through another item
(up to three steps). It also asks ArcGIS for the items it records as using this one (the item
page's "Used by", for owners and administrators) and lists any the scan did not cover.

When a swap involves a missing or retyped field, the text of each of those items is searched for
the field name and the items that mention it are listed. They are never changed by a swap.

Only items the scan covered can be found this way, so scan every item type and owner for the
fullest answer. A mention is a text match on an ID or a whole-word field name, not proof of use.

## Rescanning one item

Each listed item has "Rescan this item". It reads that item again — details, data and resources —
and redraws its entry, so changes made outside this tool show without a full scan. An item with
nothing left to fix stays listed as "no references left" and drops out of the count and the CSV.
An item the scan did not list cannot be rescanned this way; run a scan filtered to it instead.

## Several listed replacements

Where Esri's table lists more than one replacement for an item (one layer split into several),
the layer shows a "Replace with" list of them. The one you pick gets the usual checks and the
layer becomes that item only; add the others to the map by hand if you need them.

## Choosing your own replacement

Each layer has "Use a different replacement item". Paste an item ID or item page address; the
item gets the same checks as a listed replacement and is labelled as your choice, not Esri's.
This is the only way to swap a layer whose retiring item has no replacement listed.

## What a swap does

Re-reads the item and stops if it changed since it was last read (rescan it to carry on); the first time an item is changed,
downloads its current data as a backup file and keeps a copy in memory; changes only `url`,
`itemId`, (if ticked) `title` and (if you mapped a field) the settings that name that field, on
that one layer; saves; reads the item back and confirms the new values. "Apply all swaps that are
ready" does the same for every ready layer of an item in one save.

**Undo.** "Undo: restore the backup" writes the in-memory backup back, returning the item to how
it was before the first swap in this page session. After a reload, "Restore from a backup file…"
does the same from the downloaded file. Both replace the whole item data, so later changes made
elsewhere are lost; a copy of anything the tool does not already hold is downloaded first.

## Limits

- A service URL shared by several retiring items is matched as "one of N" unless the layer also
  carries a retiring item ID.
- Numbered hosts are matched exactly (`demographics5` is not treated as `demographics1`).
- After any swap, settings the layer never set itself (pop-ups, styling) come from the new item.
- Layers that change service type (for example MapServer to FeatureServer) are reported, not swapped.

## Run and test

Serve this folder from any static host. The page's own address must be registered as a redirect
URL on the OAuth credentials whose client ID is in `config.js`.

```sh
python3 -m http.server 8010   # then open http://localhost:8010/ (not 127.0.0.1)
node --test test/*.mjs
```
