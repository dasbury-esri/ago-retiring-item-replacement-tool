// Work out what an item's data is from its bytes rather than its type, and return the text in it.

const TEXT_ENTRY = /\.(json|xml|html?|txt|js|webform|info|iteminfo|geojson|kml)$/i;
const ENTRY_LIMIT = 5 * 1024 * 1024;

const startsWith = (bytes, ...values) => values.every((value, index) => bytes[index] === value);
const decode = (bytes) => new TextDecoder().decode(bytes);

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Text files inside a zip archive, as [{ name, text }], plus how many text files were too big to read. */
export async function unzipText(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('zip archive has no directory');
  const total = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (at === 0xffffffff) throw new Error('zip64 archives are not supported');
  const files = [];
  let skipped = 0;
  for (let index = 0; index < total && view.getUint32(at, true) === 0x02014b50; index += 1) {
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (!TEXT_ENTRY.test(name)) continue;
    if (size > ENTRY_LIMIT || (method !== 0 && method !== 8)) { skipped += 1; continue; }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + packed);
    files.push({ name, text: decode(method === 8 ? await inflate(raw) : raw) });
  }
  return { files, skipped };
}

/**
 * @returns {{ documents: {name: string, text: string}[], unread: string|null }}
 *   documents: "data" for JSON or other text, "data.zip/<path>" for text files in a zip.
 *   unread: why some or all of the content could not be read, or null.
 */
export async function readContent(bytes) {
  if (!bytes.length) return { documents: [], unread: null };
  if (startsWith(bytes, 0x50, 0x4b)) {
    const { files, skipped } = await unzipText(bytes);
    return {
      documents: files.map((file) => ({ name: `data.zip/${file.name}`, text: file.text })),
      unread: skipped ? `${skipped} text file${skipped === 1 ? '' : 's'} in the zipped item data could not be read` : null,
    };
  }
  if (startsWith(bytes, 0x37, 0x7a, 0xbc, 0xaf)) return { documents: [], unread: 'item data is a 7z archive, which a browser cannot open' };
  if (bytes.subarray(0, 4096).includes(0)) return { documents: [], unread: 'item data is a binary file, which cannot be read for references' };
  return { documents: [{ name: 'data', text: decode(bytes).replace(/^﻿/, '') }], unread: null };
}
