import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { packageVersion } from "./cli.js";
import type { EntityModule, Registry } from "./registry.js";
import { EntityType, type Access } from "./types.js";
import { transactionsModule } from "./entities/transactions.js";
import { accountsModule } from "./entities/accounts.js";
import { categoriesModule } from "./entities/categories.js";
import { tagsModule } from "./entities/tags.js";
import { budgetsModule } from "./entities/budgets.js";
import { billsModule } from "./entities/bills.js";
import { piggyBanksModule } from "./entities/piggyBanks.js";
import { rulesModule } from "./entities/rules.js";
import { ruleGroupsModule } from "./entities/ruleGroups.js";
import { insightModule } from "./entities/insight.js";
import { summaryModule } from "./entities/summary.js";
import { analysisModule } from "./entities/analysis.js";
import { resolveModule } from "./entities/resolve.js";
import { searchModule } from "./entities/search.js";
import { currenciesModule, exchangeRatesModule, attachmentsModule, recurringModule, autocompleteModule } from "./entities/financial.js";
import { availableBudgetsModule, linksModule, linkTypesModule, objectGroupsModule, preferencesModule, configurationModule, dataExportModule } from "./entities/advanced.js";

/** Entity modules registered on startup.
 *
 * Each entity migration plan appends its module here.
 */
export const ENTITY_MODULES: EntityModule[] = [accountsModule, transactionsModule, budgetsModule, categoriesModule, tagsModule, insightModule, summaryModule, searchModule, billsModule, piggyBanksModule, rulesModule, ruleGroupsModule, currenciesModule, exchangeRatesModule, attachmentsModule, recurringModule, autocompleteModule, availableBudgetsModule, linksModule, linkTypesModule, objectGroupsModule, preferencesModule, configurationModule, dataExportModule, analysisModule, resolveModule];

/** The catalogue is embedded here rather than fetched, so choosing an entity
 * and operation costs the model no extra tool call.
 *
 * Each surface carries only its own operations, and only the reading surface
 * repeats the entity hints — see `Registry.operationCatalogue` for why.
 */
export function executeDescription(registry: Registry, surface?: Surface): string {
  const allowed = surface?.access;
  return [
    surface?.summary ?? "Execute any Firefly III operation.",
    "",
    "Available entities and their operations:",
    registry.operationCatalogue(allowed, surface?.hints ?? true),
    "",
    "Call firefly_get_schema(entity, operation) for the parameters an operation accepts.",
    "",
    "Empty and null attributes are already stripped from every response. For large " +
      "result sets, pass `fields` to keep only the attributes you need (e.g. " +
      '["date", "amount", "description", "category_name"] when summarising spending) — ' +
      "this can cut the response by ~90%. Omit `fields` when you do not know yet which " +
      "attributes matter.",
  ].join("\n");
}

function asError(caught: unknown): { error: string } {
  return { error: caught instanceof Error ? caught.message : String(caught) };
}

/** MCP tool annotations for an operation's access level.
 *
 * These are hints a host uses to decide what to confirm with the user, so they
 * are stated from what the registry already knows rather than guessed. Firefly
 * is a remote service in every case, hence `openWorldHint`.
 *
 * `idempotentHint` is claimed only for `destructive`, where it is true and
 * useful: deleting the same record twice leaves the same end state. It is left
 * off `write`, because `create` is the opposite of idempotent — repeating it
 * makes a second transaction.
 */
function annotationsFor(access: Access): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
} {
  return {
    readOnlyHint: access === "read",
    destructiveHint: access === "destructive",
    ...(access === "destructive" ? { idempotentHint: true } : {}),
    openWorldHint: true,
  };
}

/** Wrap a JSON payload as MCP tool-call content.
 *
 * A type-annotated helper (rather than inline object literals) so the
 * `"text"` literal type checks against the SDK's content union without a
 * type assertion.
 */
function toolResult(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export function createServer(registry: Registry, config: Config): McpServer {
  // Read from package.json rather than written down here: a second copy is a
  // copy that goes stale, and this one did — the server introduced itself as
  // 0.1.0 while the package shipped 0.3.2.
  const server = new McpServer({ name: "Firefly MCP Server", version: packageVersion() });

  // Either/or, as in the Python version: direct mode replaces the meta-tools.
  if (config.directMode) registerDirectModeTools(server, registry);
  else registerMetaTools(server, registry, config);

  return server;
}

/** One execute tool per risk level.
 *
 * A single tool that could both list and delete gave the host nothing to
 * annotate: it had to treat reading a balance and deleting a transaction
 * alike. Each surface here admits only its own access level — enforced in
 * `Registry.execute`, not just advertised — so `destructiveHint` means what it
 * says.
 */
type Surface = { tool: string; access: readonly Access[]; summary: string; hints: boolean };

const SURFACES: Surface[] = [
  {
    tool: "firefly_query",
    access: ["read"],
    hints: true,
    summary: "Read from Firefly III. Never changes anything.",
  },
  {
    tool: "firefly_mutate",
    access: ["write"],
    hints: false,
    summary:
      "Create or change records in Firefly III. Does not delete anything, and does not " +
      "rewrite fields across many records at once — use firefly_destructive for those.",
  },
  {
    tool: "firefly_destructive",
    access: ["destructive"],
    hints: false,
    summary:
      "Delete records, or rewrite one field across many records in a single call. " +
      "None of this can be undone through this server; confirm with the user first.",
  },
];

function registerMetaTools(server: McpServer, registry: Registry, config: Config): void {
  for (const surface of SURFACES) {
    // Read-only mode leaves the writing surfaces with an empty catalogue.
    // Registering a tool that can only refuse would send the model down a dead
    // end, which is the same reason the operations themselves are hidden.
    if (config.readOnly && !surface.access.includes("read")) continue;

    server.registerTool(
      surface.tool,
      {
        description: executeDescription(registry, surface),
        annotations: annotationsFor(surface.access[0]!),
        inputSchema: {
          entity: z.string().describe("Entity type (account, transaction, budget, ...)"),
          operation: z.string().describe("Operation name (list, get, create, ...)"),
          params: z.record(z.unknown()).optional().describe("Operation parameters"),
          fields: z.array(z.string()).optional().describe("Attribute allow-list for the response"),
          ...(surface.access.includes("read")
            ? {}
            : {
                dry_run: z
                  .boolean()
                  .optional()
                  .describe(
                    "Preview instead of applying: returns the exact request that would be sent, " +
                      "plus warnings such as a possible duplicate transaction. Nothing is written.",
                  ),
              }),
        },
      },
      async ({ entity, operation, params, fields, dry_run }) => {
        const payload = await registry
          .execute(entity, operation, params, fields, surface.access, dry_run === true)
          .catch((caught: unknown) => asError(caught));
        return toolResult(payload);
      },
    );
  }

  server.registerTool(
    "firefly_list_operations",
    {
      description: "List available Firefly III operations, optionally filtered by entity.",
      annotations: annotationsFor("read"),
      inputSchema: { entity: z.nativeEnum(EntityType).optional() },
    },
    // `entity` is already a validated EntityType and listOperations filters a
    // missing module rather than throwing, so there is nothing to catch here.
    ({ entity }) => toolResult(registry.listOperations(entity)),
  );

  server.registerTool(
    "firefly_get_schema",
    {
      description: "Get the parameter schema for a specific operation.",
      annotations: annotationsFor("read"),
      inputSchema: { entity: z.string(), operation: z.string() },
    },
    ({ entity, operation }) => {
      const payload = ((): unknown => {
        try {
          return registry.getSchema(entity, operation);
        } catch (caught) {
          return asError(caught);
        }
      })();
      return toolResult(payload);
    },
  );
}

/** One MCP tool per operation, in place of the three meta-tools.
 *
 * Off by default: most MCP clients degrade past ~40 tools, which is why the
 * meta-tools exist. Kept for clients that prefer explicit tools.
 *
 * Tool names are `<entity>_<operation>`, matching the Python version's
 * `f"{entity}_{operation}"` exactly — no `firefly_` prefix.
 */
function registerDirectModeTools(server: McpServer, registry: Registry): void {
  for (const module of registry.entityModules()) {
    for (const info of registry.listOperations(module.entity)) {
      const operation = module.operations[info.operation];
      if (!operation) continue;

      server.registerTool(
        `${module.entity}_${info.operation}`,
        {
          description: operation.description,
          annotations: annotationsFor(operation.access),
          // The whole strict schema, not `.shape`. A raw shape is rebuilt by
          // the SDK as a strip-mode object: an unknown key would be deleted
          // before `Registry.execute` ever saw it, and an operation whose
          // fields are all optional would then run unfiltered instead of
          // failing. Passing the schema itself keeps the SDK's own parse
          // strict while the advertised JSON Schema stays per-parameter.
          inputSchema: operation.input,
        },
        async (params: unknown) => {
          const payload = await registry
            .execute(module.entity, info.operation, params)
            .catch((caught: unknown) => asError(caught));
          return toolResult(payload);
        },
      );
    }
  }
}
