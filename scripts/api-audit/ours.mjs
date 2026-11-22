// Maintainer tool, not part of the published package.
//
// Records, for every write and destructive operation, the endpoint it calls
// and every field it can send. Each operation runs once against a recording
// client with a sample input in which every field, optional ones included, is
// filled — so the recorded body is the full set of keys the server can send.

import { z } from "zod";

const SAMPLE_STRINGS = ["1", "2026-01-01", "2026-01-01T00:00:00+00:00", "abc"];

function sampleString(schema) {
  if (schema.pattern) {
    const pattern = new RegExp(schema.pattern);
    const fit = SAMPLE_STRINGS.find((value) => pattern.test(value));
    if (fit) return fit;
  }
  if (schema.format === "date") return "2026-01-01";
  if (schema.format === "date-time") return "2026-01-01T00:00:00+00:00";
  return "1".padEnd(schema.minLength ?? 1, "1");
}

/** A value for this JSON schema with every property present. */
function sample(schema) {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  const branch = schema.anyOf ?? schema.oneOf;
  if (branch) return sample(branch.find((option) => option.type !== "null") ?? branch[0]);
  if (schema.allOf) return sample(schema.allOf[0]);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  switch (type) {
    case "object":
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, sample(value)]));
    case "array":
      return Array.from({ length: Math.max(1, schema.minItems ?? 1) }, () => sample(schema.items ?? {}));
    case "string": return sampleString(schema);
    case "integer": return Math.max(1, schema.minimum ?? 1);
    case "number": return Math.max(1, schema.minimum ?? 1);
    case "boolean": return true;
    default: return "1";
  }
}

/** Top-level keys, plus `key.*.field` for arrays of objects. */
function keysOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const keys = [];
  for (const [key, inner] of Object.entries(value)) {
    keys.push(key);
    if (Array.isArray(inner) && inner[0] && typeof inner[0] === "object" && !Array.isArray(inner[0])) {
      for (const field of Object.keys(inner[0])) keys.push(`${key}.*.${field}`);
    }
  }
  return keys;
}

function recordingClient() {
  const writes = [];
  const reply = { data: [], meta: { pagination: { total_pages: 1 } } };
  return {
    writes,
    client: {
      get: async () => reply,
      getText: async () => "",
      post: async (path, body, query) => { writes.push({ method: "POST", path, body, query }); return { data: {} }; },
      put: async (path, body) => { writes.push({ method: "PUT", path, body }); return { data: {} }; },
      del: async (path, query) => { writes.push({ method: "DELETE", path, query }); return null; },
      postBinary: async (path) => { writes.push({ method: "POST", path }); return null; },
    },
  };
}

/**
 * @param {Array<{ entity: string, operations: Record<string, { access: string, input: unknown, handler: Function }> }>} modules
 * @returns {Promise<Array<{ name: string, method: string, path: string, bodyKeys: string[], queryKeys: string[], error?: string }>>}
 */
export async function collectWriteOperations(modules) {
  const results = [];
  for (const module of modules) {
    for (const [operation, spec] of Object.entries(module.operations)) {
      if (spec.access === "read") continue;
      const name = `${module.entity}.${operation}`;
      const schema = z.toJSONSchema(spec.input, { io: "input", reused: "inline", unrepresentable: "any" });
      const { writes, client } = recordingClient();
      let error;
      try {
        await spec.handler(sample(schema), client);
      } catch (caught) {
        error = caught instanceof Error ? caught.message.split("\n")[0] : String(caught);
      }
      const write = writes[0];
      if (!write) {
        results.push({ name, method: "", path: "", bodyKeys: [], queryKeys: [], error: error ?? "no write recorded" });
        continue;
      }
      results.push({
        name,
        method: write.method,
        path: write.path.replace(/\/\d+(?=\/|$)/g, "/{id}"),
        bodyKeys: keysOf(write.body),
        queryKeys: keysOf(write.query),
        ...(error ? { error } : {}),
      });
    }
  }
  return results;
}
