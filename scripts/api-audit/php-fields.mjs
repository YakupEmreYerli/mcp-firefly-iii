// Maintainer tool, not part of the published package.
//
// Pulls out of a Firefly III API request class (app/Api/V1/Requests/...)
// which request fields it reads and which it validates. Reading is what
// counts: a field Firefly validates but never reads is dropped, and one it
// reads is what the server stores. A light scan, not a PHP parser: Firefly's
// request classes follow a few fixed shapes, and the tests pin those.

/** Split a class into its methods: name → body (braces balanced). */
function methods(php) {
  const found = [];
  const header = /function\s+(\w+)\s*\([^)]*\)[^{;]*\{/g;
  let match;
  while ((match = header.exec(php)) !== null) {
    let depth = 1;
    let i = header.lastIndex;
    for (; i < php.length && depth > 0; i++) {
      if (php[i] === "{") depth++;
      else if (php[i] === "}") depth--;
    }
    found.push({ name: match[1], body: php.slice(header.lastIndex, i - 1) });
    header.lastIndex = i;
  }
  return found;
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

const HELPER = /\$this->(?:has|get|boolean|date|integer|float|string\w*|convert\w*|nullable\w*)\(\s*'([^']+)'/g;
// `'internal' => ['request_field', 'converter']` — the request field is the value.
const FIELD_MAP = /'[^']+'\s*=>\s*\[\s*'([^']+)'\s*,\s*'[^']+'\s*\]/g;

function readFields(body, read) {
  // Variables holding a request array: `$x = $this->get('name')`, loop variables
  // over it, and NullArrayObject wrappers of those.
  const arrays = new Map();
  const events = [];
  const collect = (regex, kind) => {
    for (const m of body.matchAll(regex)) events.push({ at: m.index, kind, m });
  };
  collect(/\$(\w+)\s*=\s*\$this->get\(\s*'([^']+)'\s*\)/g, "assign");
  collect(/foreach\s*\(\s*\$this->get\(\s*'([^']+)'\s*\)\s+as\s+\$(\w+)/g, "loopDirect");
  collect(/foreach\s*\(\s*\$(\w+)\s+as\s+\$(\w+)/g, "loopVar");
  collect(/\$(\w+)\s*=\s*new\s+NullArrayObject\(\s*\$(\w+)\s*\)/g, "wrap");
  collect(HELPER, "helper");
  collect(FIELD_MAP, "map");
  collect(/\$(\w+)\['([^']+)'\]/g, "index");
  events.sort((a, b) => a.at - b.at);

  for (const { kind, m } of events) {
    if (kind === "assign") { arrays.set(m[1], { source: m[2], item: false }); pushUnique(read, m[2]); }
    else if (kind === "loopDirect") { pushUnique(read, m[1]); arrays.set(m[2], { source: m[1], item: true }); }
    else if (kind === "loopVar") {
      const from = arrays.get(m[1]);
      if (from && !from.item) arrays.set(m[2], { source: from.source, item: true });
    } else if (kind === "wrap") {
      const from = arrays.get(m[2]);
      if (from) arrays.set(m[1], from);
    } else if (kind === "helper" || kind === "map") pushUnique(read, m[1]);
    else if (kind === "index") {
      const from = arrays.get(m[1]);
      if (from?.item) pushUnique(read, `${from.source}.*.${m[2]}`);
    }
  }
}

/**
 * @param {string} php source of one request class
 * @returns {{ read: string[], validated: string[] }}
 */
export function extractRequestFields(php) {
  const read = [];
  const validated = [];
  for (const { name, body } of methods(php)) {
    if (name === "withValidator" || name === "authorize" || name === "messages") continue;
    if (name === "rules") {
      // Top-level keys of the returned array: `'key' =>` at the start of a line or after `[`/`,`.
      for (const m of body.matchAll(/(?:^|[[,])\s*'([^']+)'\s*=>/gm)) pushUnique(validated, m[1]);
      continue;
    }
    readFields(body, read);
  }
  return { read, validated };
}
