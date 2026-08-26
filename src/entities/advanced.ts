import { z } from "zod";
import { defineOperation, type EntityModule, type Operation } from "../registry.js";
import { entityId, isoDate, pagination } from "../schemas/common.js";
import { EntityType } from "../types.js";

const id = z.object({ id: entityId }).strict();
const availableBudgetQuery = z.object({ start: isoDate, end: isoDate, currency_code: z.string().min(1).optional(), ...pagination }).strict();

export const availableBudgetOperations: Record<string, Operation> = {
  list: defineOperation({ description: "How much budget is available in a period?", access: "read", input: availableBudgetQuery, handler: (q, c) => c.get("/available-budgets", q) }),
};
export const availableBudgetsModule: EntityModule = { entity: EntityType.AvailableBudget, hint: "remaining budget amounts for a date range", operations: availableBudgetOperations };

const linkTypeData = z.object({ name: z.string().min(1), inward: z.string().min(1), outward: z.string().min(1) }).strict();
const linkData = z.object({ link_type_id: entityId.optional(), link_type_name: z.string().min(1).optional(), inward_id: entityId, outward_id: entityId, notes: z.string().optional() }).strict();
const linkUpdate = z.object({ link_type_id: entityId, inward_id: entityId, outward_id: entityId, notes: z.string().optional() }).strict();

export const linksModule: EntityModule = {
  entity: EntityType.TransactionLink, hint: "relationships between transaction journals and their link types", operations: {
    list: defineOperation({ description: "Which transaction links exist?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/transaction-links", q) }),
    get: defineOperation({ description: "What is this transaction link?", access: "read", input: id, handler: ({ id }, c) => c.get(`/transaction-links/${id}`) }),
    create: defineOperation({ description: "Link two transactions.", access: "write", input: linkData, handler: (b, c) => c.post("/transaction-links", b) }),
    update: defineOperation({ description: "Change a transaction link; Firefly requires the complete link identity on update.", access: "write", input: z.object({ id: entityId, transaction_link_update: linkUpdate }).strict(), handler: ({ id, transaction_link_update }, c) => c.put(`/transaction-links/${id}`, transaction_link_update) }),
    delete: defineOperation({ description: "Delete a transaction link.", access: "write", input: id, handler: async ({ id }, c) => { await c.del(`/transaction-links/${id}`); return { deleted: true, id }; } }),
  },
};

export const objectGroupsModule: EntityModule = {
  entity: EntityType.ObjectGroup, hint: "user-defined ordering groups for financial objects", operations: {
    list: defineOperation({ description: "Which object groups exist?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/object-groups", q) }),
    get: defineOperation({ description: "What is this object group?", access: "read", input: id, handler: ({ id }, c) => c.get(`/object-groups/${id}`) }),
  },
};

export const linkTypeOperations: Record<string, Operation> = {
  list: defineOperation({ description: "Which transaction link types exist?", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/link-types", q) }),
  get: defineOperation({ description: "What is this transaction link type?", access: "read", input: id, handler: ({ id }, c) => c.get(`/link-types/${id}`) }),
  list_transactions: defineOperation({ description: "Which transactions use this link type?", access: "read", input: z.object({ id: entityId, ...pagination }).strict(), handler: ({ id, ...q }, c) => c.get(`/link-types/${id}/transactions`, q) }),
};
export const linkTypesModule: EntityModule = { entity: EntityType.LinkType, hint: "custom names for transaction relationships", operations: linkTypeOperations };

const preferenceData = z.object({ name: z.string().min(1), data: z.unknown() }).strict();
export const preferencesModule: EntityModule = { entity: EntityType.Preference, hint: "user display and behavior preferences", operations: {
  list: defineOperation({ description: "List user preferences.", access: "read", input: z.object({ ...pagination }).strict(), handler: (q, c) => c.get("/preferences", q) }),
  get: defineOperation({ description: "Get a user preference.", access: "read", input: z.object({ name: z.string().min(1) }).strict(), handler: ({ name }, c) => c.get(`/preferences/${name}`) }),
} };

export const configurationModule: EntityModule = { entity: EntityType.Configuration, hint: "Firefly system configuration values", operations: {
  list: defineOperation({ description: "List system configuration values.", access: "read", input: z.object({}).strict(), handler: (_, c) => c.get("/configuration") }),
  get: defineOperation({ description: "Get one system configuration value.", access: "read", input: z.object({ name: z.string().min(1) }).strict(), handler: ({ name }, c) => c.get(`/configuration/${name}`) }),
} };

const exportQuery = z.object({ start: isoDate.optional(), end: isoDate.optional(), format: z.enum(["raw", "json"]).default("raw"), ...pagination }).strict();
const exportKinds = ["accounts", "bills", "budgets", "categories", "piggy-banks", "recurring"] as const;
export const dataExportOperations: Record<string, Operation> = {};
function parseCsvRow(row: string): string[] {
  const cells: string[] = []; let cell = ""; let quoted = false;
  for (let i = 0; i < row.length; i++) { const ch = row[i]; if (ch === '"') { if (quoted && row[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; } else if (ch === "," && !quoted) { cells.push(cell); cell = ""; } else cell += ch; }
  cells.push(cell); return cells;
}
function jsonExport(raw: string): unknown[] {
  const rows = raw.replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/).map(parseCsvRow); if (rows.length < 2) return [];
  const headers = rows[0]!;
  return rows.slice(1).filter(row => row.some(Boolean)).map(row => Object.fromEntries(headers.map((header, i) => [header, row[i] ?? ""])));
}
for (const kind of exportKinds) dataExportOperations[kind.replaceAll("-", "_")] = defineOperation({ description: `Export ${kind} data. Default is Firefly's original CSV; use json for a structured view.`, access: "read", input: exportQuery, handler: async ({ format, ...q }, c) => { const raw = await c.getText(`/data/export/${kind}`, q); return format === "json" ? jsonExport(raw) : raw; } });
export const dataExportModule: EntityModule = { entity: EntityType.DataExport, hint: "CSV-style Firefly data exports; imports are handled by Data Importer", operations: dataExportOperations };
