// Maintainer tool, not part of the published package.
//
// Given which fields each Firefly III release reads, oldest first, names the
// release that introduced every field the oldest one did not read. A field a
// newer Firefly reads is dropped silently by an older one, so this is the list
// of fields that need a version check.

/**
 * @param {Array<{ ref: string, reads: Record<string, string[]> }>} readsByRef oldest first
 * @returns {Array<{ operation: string, field: string, since: string }>}
 */
export function fieldIntroductions(readsByRef) {
  if (readsByRef.length === 0) return [];
  const seen = new Map();
  for (const [operation, fields] of Object.entries(readsByRef[0].reads)) seen.set(operation, new Set(fields));
  const found = [];
  for (const { ref, reads } of readsByRef.slice(1)) {
    for (const [operation, fields] of Object.entries(reads)) {
      const known = seen.get(operation) ?? new Set();
      for (const field of fields) {
        if (!known.has(field)) {
          found.push({ operation, field, since: ref });
          known.add(field);
        }
      }
      seen.set(operation, known);
    }
  }
  return found;
}
