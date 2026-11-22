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

// Any `$this->helper('field'` — Firefly's converters, `has`/`get`, and a
// class's own private readers such as `getDate('start')`.
const HELPER = /\$this->\w+\(\s*'([a-z_]+)'/g;
// `'internal' => ['request_field', 'converter']` — the request field is the value.
const FIELD_MAP = /'[^']+'\s*=>\s*\[\s*'([^']+)'\s*,\s*'[^']+'\s*\]/g;

/**
 * Variable and property state shared by every method of the class: a loop
 * item in one method is often handed to a helper defined earlier in the file
 * under the same parameter name, so the scan runs twice over all methods.
 */
function scanReaders(bodies) {
  const arrays = new Map(); // $var → { source, item }
  const lists = new Map(); // $this->prop → ['field', ...]
  const read = [];
  for (const pass of [1, 2]) {
    for (const body of bodies) {
      const fieldVars = new Map(); // $fieldName → prop list, inside this method
      const events = [];
      const collect = (regex, kind) => {
        for (const m of body.matchAll(regex)) events.push({ at: m.index, kind, m });
      };
      collect(/\$this->(\w+)\s*=\s*\[([^\]]*)\]/g, "list");
      collect(/\$(\w+)\s*=\s*\$this->get\(\s*'([^']+)'\s*\)/g, "assign");
      collect(/foreach\s*\(\s*\$this->get\(\s*'([^']+)'\s*\)\s+as\s+\$(\w+)/g, "loopDirect");
      collect(/foreach\s*\(\s*\$this->(\w+)\s+as\s+\$(\w+)/g, "loopList");
      collect(/foreach\s*\(\s*\$(\w+)\s+as\s+\$(\w+)/g, "loopVar");
      collect(/\$(\w+)\s*=\s*new\s+NullArrayObject\(\s*\$(\w+)\s*\)/g, "wrap");
      collect(HELPER, "helper");
      collect(FIELD_MAP, "map");
      collect(/\$(\w+)\['([^']+)'\]/g, "index");
      collect(/\$(\w+)\[\$(\w+)\]/g, "indexVar");
      events.sort((a, b) => a.at - b.at);

      const take = (value) => { if (pass === 2) pushUnique(read, value); };
      for (const { kind, m } of events) {
        if (kind === "list") lists.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
        else if (kind === "assign") { arrays.set(m[1], { source: m[2], item: false }); take(m[2]); }
        else if (kind === "loopDirect") { take(m[1]); arrays.set(m[2], { source: m[1], item: true }); }
        else if (kind === "loopList") fieldVars.set(m[2], m[1]);
        else if (kind === "loopVar") {
          const from = arrays.get(m[1]);
          if (from && !from.item) arrays.set(m[2], { source: from.source, item: true });
        } else if (kind === "wrap") {
          const from = arrays.get(m[2]);
          if (from) arrays.set(m[1], from);
        } else if (kind === "helper" || kind === "map") take(m[1]);
        else if (kind === "index") {
          const from = arrays.get(m[1]);
          if (from?.item) take(`${from.source}.*.${m[2]}`);
        } else if (kind === "indexVar") {
          const from = arrays.get(m[1]);
          const list = lists.get(fieldVars.get(m[2]));
          if (from?.item && list) for (const field of list) take(`${from.source}.*.${field}`);
        }
      }
    }
  }
  return read;
}

/**
 * @param {string} php source of one request class
 * @returns {{ read: string[], validated: string[] }}
 */
export function extractRequestFields(php) {
  const validated = [];
  const readers = [];
  for (const { name, body } of methods(php)) {
    if (name === "withValidator" || name === "authorize" || name === "messages") continue;
    if (name === "rules") {
      // Top-level keys of the returned array: `'key' =>` at the start of a line or after `[`/`,`.
      for (const m of body.matchAll(/(?:^|[[,])\s*'([^']+)'\s*=>/gm)) pushUnique(validated, m[1]);
      continue;
    }
    readers.push(body);
  }
  return { read: scanReaders(readers), validated };
}
