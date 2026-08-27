import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { EntityModule, Registry } from "./registry.js";
import { EntityType } from "./types.js";
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
import { searchModule } from "./entities/search.js";
import { currenciesModule, exchangeRatesModule, attachmentsModule, recurringModule, autocompleteModule } from "./entities/financial.js";
import { availableBudgetsModule, linksModule, linkTypesModule, objectGroupsModule, preferencesModule, configurationModule, dataExportModule } from "./entities/advanced.js";

/** Entity modules registered on startup.
 *
 * Each entity migration plan appends its module here.
 */
export const ENTITY_MODULES: EntityModule[] = [accountsModule, transactionsModule, budgetsModule, categoriesModule, tagsModule, insightModule, summaryModule, searchModule, billsModule, piggyBanksModule, rulesModule, ruleGroupsModule, currenciesModule, exchangeRatesModule, attachmentsModule, recurringModule, autocompleteModule, availableBudgetsModule, linksModule, linkTypesModule, objectGroupsModule, preferencesModule, configurationModule, dataExportModule, analysisModule];

/** The catalogue is embedded here rather than fetched, so choosing an entity
 * and operation costs the model no extra tool call. */
export function executeDescription(registry: Registry): string {
  return [
    "Execute any Firefly III operation.",
    "",
    "Available entities and their operations:",
    registry.operationCatalogue(),
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
  const server = new McpServer({ name: "Firefly MCP Server", version: "0.1.0" });

  // Either/or, as in the Python version: direct mode replaces the meta-tools.
  if (config.directMode) registerDirectModeTools(server, registry);
  else registerMetaTools(server, registry);

  return server;
}

function registerMetaTools(server: McpServer, registry: Registry): void {
  server.registerTool(
    "firefly_execute",
    {
      description: executeDescription(registry),
      inputSchema: {
        entity: z.string().describe("Entity type (account, transaction, budget, ...)"),
        operation: z.string().describe("Operation name (list, get, create, ...)"),
        params: z.record(z.unknown()).optional().describe("Operation parameters"),
        fields: z.array(z.string()).optional().describe("Attribute allow-list for the response"),
      },
    },
    async ({ entity, operation, params, fields }) => {
      const payload = await registry
        .execute(entity, operation, params, fields)
        .catch((caught: unknown) => asError(caught));
      return toolResult(payload);
    },
  );

  server.registerTool(
    "firefly_list_operations",
    {
      description: "List available Firefly III operations, optionally filtered by entity.",
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
