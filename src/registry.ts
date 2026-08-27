import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { permits, type Config } from "./config.js";
import { duplicateWarnings, previewClient, type PlannedWrite } from "./preview.js";
import type { FireflyClient } from "./firefly.js";
import { EntityType, type Access } from "./types.js";
import {
  WrongAccessSurfaceError,
  PermissionDeniedError,
  EntityNotAvailableError,
  OperationNotFoundError,
  ReadOnlyModeError,
  ValidationError,
} from "./errors.js";
import { projectFields, stripEmpty } from "./projection.js";
import { flattenTransactions } from "./flatten.js";

/** An input schema that rejects unknown keys.
 *
 * `.strict()` is this layer's home for the Firefly quirk where a PUT carrying
 * an unknown wrapper key returns 200 and changes nothing. A plain
 * `z.object({...})` would strip the stray key and let the call through, and
 * `zodToJsonSchema` emits `additionalProperties: false` either way — so the
 * published schema cannot reveal the difference. Zod carries the
 * unknown-key policy in the type, so the constraint makes a non-strict input
 * a compile error rather than a convention.
 */
export type StrictInput = z.ZodObject<z.ZodRawShape, "strict">;

/** An operation with its parameter type erased.
 *
 * This is the shape an `EntityModule` stores and the `Registry` runs. Build
 * one with `defineOperation`, which is where the handler gets its parameters
 * typed; the erased handler deliberately takes `unknown`, so a hand-written
 * literal cannot reach into params at all.
 */
export interface Operation {
  /** Written as the question this operation answers — it is what the model
   * reads when choosing between operations. */
  description: string;
  access: Access;
  input: StrictInput;
  handler: (params: unknown, client: FireflyClient) => Promise<unknown>;
}

/** Define an operation whose handler is typed by its own input schema.
 *
 * Without this, `EntityModule.operations` would hold `Operation<AnyZodObject>`
 * and every handler would be written against `{ [x: string]: any }` — a
 * mistyped parameter name would compile, and the failure mode is `undefined`
 * in a URL or a dropped query filter: a silently wrong financial answer, not
 * a crash. Here a name the schema does not declare is a compile error.
 *
 * The handler re-parses with `spec.input` — the very schema `Registry.execute`
 * validated with, so the two cannot diverge — because that is how `unknown`
 * becomes `z.infer<I>` without a type assertion. `Registry.execute` remains
 * the single validation gate; this second pass is a no-op on data that gate
 * already accepted.
 */
export function defineOperation<I extends StrictInput>(spec: {
  description: string;
  access: Access;
  input: I;
  handler: (params: z.infer<I>, client: FireflyClient) => Promise<unknown>;
}): Operation {
  return {
    description: spec.description,
    access: spec.access,
    input: spec.input,
    handler: (params, client) => spec.handler(spec.input.parse(params), client),
  };
}

export interface EntityModule {
  entity: EntityType;
  /** One clause appended to the catalogue line. The catalogue lists operation
   * names only, so this is what tells the model which entity answers a
   * question. */
  hint: string;
  operations: Record<string, Operation>;
}

export type OperationInfo = {
  name: string;
  entity: string;
  operation: string;
  description: string;
  access: Access;
};

function toEntityType(value: string): EntityType {
  const match = Object.values(EntityType).find((entity) => entity === value);
  if (!match) throw new EntityNotAvailableError(`No entity module for: ${value}`);
  return match;
}

export class Registry {
  private readonly modules = new Map<EntityType, EntityModule>();

  constructor(
    private readonly config: Config,
    private readonly client: FireflyClient,
  ) {}

  register(module: EntityModule): void {
    if (!this.config.enabledEntities.has(module.entity)) return;
    this.modules.set(module.entity, module);
  }

  entityModules(): EntityModule[] {
    return [...this.modules.values()].sort((a, b) => a.entity.localeCompare(b.entity));
  }

  /** Operations this server admits to having.
   *
   * Hiding writes is not the enforcement — `execute` is — but advertising an
   * operation that always refuses would send the model down a dead end.
   */
  private visibleOperations(module: EntityModule): [string, Operation][] {
    return Object.entries(module.operations)
      .filter(([, op]) => this.blockedReason(module.entity, op) === undefined)
      .sort(([a], [b]) => a.localeCompare(b));
  }

  /** Why this operation is unavailable, or undefined if it is available.
   *
   * Read-only mode is checked first and separately from the permission policy,
   * even though it is the stricter of the two: an operator who set
   * FIREFLY_READ_ONLY should be told that, not sent to look at a permissions
   * string they may not have written.
   */
  private blockedReason(entity: EntityType, operation: Operation): string | undefined {
    // Blocks anything that is not a read, rather than naming what to block: a
    // new access level then arrives closed in read-only mode instead of
    // silently callable, which is the failure this field exists to prevent.
    if (this.config.readOnly && operation.access !== "read") {
      return "writes to Firefly III and the server is running with FIREFLY_READ_ONLY enabled";
    }
    if (!permits(this.config.permissions, entity, operation.access)) {
      return `needs ${operation.access} access on '${entity}', which FIREFLY_PERMISSIONS does not grant`;
    }
    return undefined;
  }

  private lookup(entity: string, operation: string, allowed?: readonly Access[]): [EntityModule, Operation] {
    const entityType = toEntityType(entity);
    const module = this.modules.get(entityType);
    if (!module) throw new EntityNotAvailableError(`No entity module for: ${entity}`);

    const found = module.operations[operation];
    if (!found) throw new OperationNotFoundError(`Unknown operation: ${entity}.${operation}`);

    const blocked = this.blockedReason(entityType, found);
    if (blocked !== undefined) {
      const message = `'${entity}.${operation}' ${blocked}.`;
      throw blocked.includes("FIREFLY_READ_ONLY")
        ? new ReadOnlyModeError(message)
        : new PermissionDeniedError(message);
    }
    // The surfaces advertise different risk annotations, so the gate has to
    // hold them apart here. Checking in the tool handler instead would leave
    // the annotation as a claim rather than a guarantee.
    if (allowed && !allowed.includes(found.access)) {
      throw new WrongAccessSurfaceError(
        `'${entity}.${operation}' is a ${found.access} operation and cannot be called through this tool. ` +
          `Use firefly_${found.access === "read" ? "query" : found.access === "write" ? "mutate" : "destructive"} instead.`,
      );
    }
    return [module, found];
  }

  listOperations(entity?: EntityType): OperationInfo[] {
    const modules = entity
      ? [this.modules.get(entity)].filter((module): module is EntityModule => module !== undefined)
      : this.entityModules();

    return modules
      .flatMap((module) =>
        this.visibleOperations(module).map(([name, operation]) => ({
          name: `${module.entity}.${name}`,
          entity: module.entity,
          operation: name,
          description: operation.description,
          access: operation.access,
        })),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The catalogue, optionally narrowed to one access level.
   *
   * An entity with nothing at this level is dropped rather than listed empty.
   *
   * `includeHints` exists for cost. Splitting one catalogue into three repeats
   * every entity hint three times, which measured at +55% over the combined
   * text. The hint is there to help the model pick an entity while exploring,
   * which is the reading surface's job; by the time a caller is deleting, the
   * entity is already settled. Dropping it from the writing surfaces brings
   * the overhead to +12%.
   */
  operationCatalogue(allowed?: readonly Access[], includeHints = true): string {
    return this.entityModules()
      .map((module) => {
        const names = this.visibleOperations(module)
          .filter(([, op]) => !allowed || allowed.includes(op.access))
          .map(([name]) => name);
        if (names.length === 0) return "";
        const line = `  ${module.entity}: ${names.join(", ")}`;
        return includeHints ? `${line} — ${module.hint}` : line;
      })
      .filter((line) => line !== "")
      .join("\n");
  }

  getSchema(entity: string, operation: string): unknown {
    const [, found] = this.lookup(entity, operation);
    return zodToJsonSchema(found.input, { $refStrategy: "none" });
  }

  async execute(
    entity: string,
    operation: string,
    params?: unknown,
    fields?: string[],
    allowed?: readonly Access[],
    dryRun = false,
  ): Promise<unknown> {
    const [, found] = this.lookup(entity, operation, allowed);

    const parsed = found.input.safeParse(params ?? {});
    if (!parsed.success) {
      // The schema travels with the refusal. Zod says "Required" for a missing
      // field and nothing about its shape, which costs the caller a second
      // round-trip through firefly_get_schema just to learn that a date is
      // `YYYY-MM-DD`. Answering the follow-up question up front is cheaper
      // than the extra call.
      const complaints = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new ValidationError(
        `Invalid parameters for ${entity}.${operation}: ${complaints}. ` +
          `Expected schema: ${JSON.stringify(zodToJsonSchema(found.input, { $refStrategy: "none" }))}`,
      );
    }

    // A preview runs the handler against a client that reads for real and only
    // records writes, so the plan comes back with ids resolved and the payload
    // shaped as Firefly would receive it — not an echo of the parameters. A
    // read has nothing to preview, so it simply runs.
    if (dryRun && found.access !== "read") {
      const plan: PlannedWrite[] = [];
      await found.handler(parsed.data, previewClient(this.client, plan));
      const warnings = await duplicateWarnings(plan, this.client);
      return {
        dry_run: true,
        entity,
        operation,
        would_send: plan,
        ...(warnings.length > 0 ? { warnings } : {}),
        note: "Nothing was written. Call again without dry_run to apply this.",
      };
    }

    const result = await found.handler(parsed.data, this.client);
    // Flatten before projecting, so `fields` names the attributes the caller
    // actually sees rather than the ones buried in a split.
    return projectFields(flattenTransactions(stripEmpty(result)), fields);
  }
}
