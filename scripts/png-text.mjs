import fs from "node:fs";

/** Reading and writing a PNG `tEXt` chunk.
 *
 * The generated cards state the operation count, and something has to be able
 * to tell later whether that number is still the right one. A file kept
 * alongside them would be a second copy to maintain — the exact failure the
 * rest of this pipeline exists to prevent — so the image carries the answer
 * itself, in the field the format has for it, and the check reads it back out
 * of the artefact rather than out of a promise about the artefact.
 *
 * Comparing pixels would have been the other option, and a worse one: it
 * needs ffmpeg and the exact fonts wherever it runs, and it fails on a
 * freetype version rather than on a wrong number.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Walk the chunks. A PNG is an 8-byte signature and then, repeatedly,
 * length / type / data / crc. */
function* chunks(data) {
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    yield { type, start: offset, end: offset + 12 + length, dataStart: offset + 8, length };
    offset += 12 + length;
  }
}

/** The value stored under `key`, or undefined. */
export function readText(file, key) {
  const data = fs.readFileSync(file);
  for (const chunk of chunks(data)) {
    if (chunk.type !== "tEXt") continue;
    const body = data.subarray(chunk.dataStart, chunk.dataStart + chunk.length);
    const split = body.indexOf(0);
    if (split < 0) continue;
    if (body.toString("latin1", 0, split) === key) return body.toString("latin1", split + 1);
  }
  return undefined;
}

/** Store `key` = `value`, replacing any chunk already using that key.
 *
 * Inserted before IEND, which the format requires to be last. Rewritten
 * rather than appended so that stamping twice cannot leave two answers in one
 * file for a reader to choose between.
 */
export function writeText(file, key, value) {
  const data = fs.readFileSync(file);
  const parts = [];
  let cursor = 0;
  for (const chunk of chunks(data)) {
    // tEXt separates keyword from value with a NUL, not a space.
    const existing = data.subarray(chunk.dataStart, chunk.dataStart + chunk.length);
    const split = existing.indexOf(0);
    const isSameKey = chunk.type === "tEXt" && split >= 0 && existing.toString("latin1", 0, split) === key;
    if (!isSameKey) continue;
    parts.push(data.subarray(cursor, chunk.start));
    cursor = chunk.end;
  }
  parts.push(data.subarray(cursor));
  const stripped = Buffer.concat(parts);

  const body = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(String(value), "latin1")]);
  const chunk = Buffer.alloc(body.length + 12);
  chunk.writeUInt32BE(body.length, 0);
  chunk.write("tEXt", 4, "latin1");
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + body.length)), 8 + body.length);

  const iend = [...chunks(stripped)].find((entry) => entry.type === "IEND");
  if (!iend) throw new Error(`${file}: no IEND chunk, so this is not a PNG this can stamp`);
  fs.writeFileSync(file, Buffer.concat([stripped.subarray(0, iend.start), chunk, stripped.subarray(iend.start)]));
}

/** The tEXt keyword the generated cards are stamped with. Named here so the
 * renderer and the check cannot drift onto two different spellings. */
export const STAMP_KEY = "firefly-mcp-operations";
