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
   service type with the same schema, offers a swap of item ID and service URL, with an optional
   layer rename. Everything else is reported with its location and the listed replacement.

A replacement can itself be deprecated and link to a newer version. The tool says so, and where
a newer version exists it offers a choice between the next version and the latest; each choice
gets its own schema check.

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

## What "same schema" means

Every layer of the retiring service exists in the replacement under the same layer ID, with the
same geometry type, and every field exists with the same type (the ObjectID field is ignored).
Extra fields in the replacement are fine. Field values, aliases and drawing are not compared:
open the item after a swap and look at it.

## What a swap does

Re-reads the item and stops if it changed since the scan; downloads the current item data as a
backup file; changes only `url`, `itemId` and (if ticked) `title` on that one layer; saves; reads
the item back and confirms the new values. To undo, restore the downloaded file with ArcGIS
Assistant or the item's update operation.

## Limits

- A service URL shared by several retiring items is matched as "one of N" unless the layer also
  carries a retiring item ID.
- Numbered hosts are matched exactly (`demographics5` is not treated as `demographics1`).
- Layers that change service type (for example MapServer to FeatureServer) are reported, not swapped.

## Run and test

Serve this folder from any static host. The page's own address must be registered as a redirect
URL on the OAuth credentials whose client ID is in `config.js`.

```sh
python3 -m http.server 8010   # then open http://localhost:8010/ (not 127.0.0.1)
node --test test/*.mjs
```
