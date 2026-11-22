// Maintainer tool, not part of the published package.
//
// Compares what a write sent with what Firefly stored, as read back
// independently. A sent field the response does not carry is reported as
// unverified rather than passed: a field Firefly drops and never echoes would
// otherwise look like a success.

function same(value, got) {
  return (
    String(got) === String(value) ||
    (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && String(got).startsWith(value.slice(0, 10))) ||
    (!Number.isNaN(Number(value)) && value !== "" && got !== null && Number(got) === Number(value)) ||
    (typeof value === "string" && typeof got === "string" && got.toLowerCase() === value.toLowerCase())
  );
}

/**
 * @param {Record<string, unknown>} sent
 * @param {Record<string, unknown>} stored
 * @param {string} [prefix]
 * @returns {{ mismatches: string[], unverified: string[] }}
 */
export function compareStored(sent, stored, prefix = "") {
  const mismatches = [];
  const unverified = [];
  for (const [key, value] of Object.entries(sent)) {
    if (!(key in stored)) { unverified.push(`${prefix}${key}`); continue; }
    const got = stored[key];
    if (Array.isArray(value) && Array.isArray(got)) {
      value.forEach((item, i) => {
        if (item && typeof item === "object" && got[i] && typeof got[i] === "object") {
          const inner = compareStored(item, got[i], `${prefix}${key}[${i}].`);
          mismatches.push(...inner.mismatches);
          unverified.push(...inner.unverified);
        }
      });
      continue;
    }
    if (value && typeof value === "object") continue;
    if (!same(value, got)) mismatches.push(`${prefix}${key}: sent ${JSON.stringify(value)}, stored ${JSON.stringify(got)}`);
  }
  return { mismatches, unverified };
}
