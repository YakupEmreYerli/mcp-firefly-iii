import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Config } from "./config.js";
import { duplicateWarnings, previewClient, type PlannedWrite } from "./preview.js";
import type { FireflyClient } from "./firefly.js";
import { EntityType, type Access } from "./types.js";
import {
  WrongAccessSurfaceError,
  PermissionDeniedError,
  EntityNotAvailableError,
  OperationNotFoundError,
  ValidationError,
} from "./errors.js";
import { projectFields, stripEmpty, markThirdPartyText } from "./projection.js";
import { flattenTransactions } from "./flatten.js";
import { localToday, resolvePeriod, type Period } from "./period.js";

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

  /** `granted` is the access a connection holds, or undefined for all of it.
   *
   * Undefined is the stdio case and the static-token case: whoever holds the
   * token already made that decision. A set arrives only from OAuth scopes. */
  constructor(
    private readonly config: Config,
    private readonly client: FireflyClient,
    private readonly granted?: ReadonlySet<Access>,
  ) {}

  register(module: EntityModule): void {
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
   * Only a connection's own grant can withhold an operation now. There is no
   * server-wide policy to consult: a stdio client has every surface, and an
   * OAuth one has what the password screen granted.
   */
  private blockedReason(entity: EntityType, operation: Operation): string | undefined {
    if (this.granted && !this.granted.has(operation.access)) {
      const scope = operation.access === "destructive" ? "firefly:destructive" : `firefly:${operation.access}`;
      return `needs ${operation.access} access on '${entity}', which this connection's ${scope} scope was not granted`;
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
      throw new PermissionDeniedError(`'${entity}.${operation}' ${blocked}.`);
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

    const args = resolveDateShortcut(entity, operation, parsed.data);

    // A preview runs the handler against a client that reads for real and only
    // records writes, so the plan comes back with ids resolved and the payload
    // shaped as Firefly would receive it — not an echo of the parameters. A
    // read has nothing to preview, so it simply runs.
    if (dryRun && found.access !== "read") {
      const plan: PlannedWrite[] = [];
      const outcome = await found.handler(args, previewClient(this.client, plan));
      const warnings = await duplicateWarnings(plan, this.client);
      // Only a refusal is carried over from the handler. An operation that
      // declines — a filter matching more rows than the caller allowed — writes
      // nothing, and an empty plan on its own cannot be told apart from a
      // filter that matched nothing at all. Its success counters are NOT
      // carried: the preview client's writes all "succeed", so a plan of ten
      // PUTs reported `updated: 10` beside a note saying nothing was written,
      // and a caller reading the count would not run it for real.
      const refusal = isRefusal(outcome) ? { outcome } : {};
      return markThirdPartyText({
        dry_run: true,
        entity,
        operation,
        would_send: plan,
        ...refusal,
        ...(warnings.length > 0 ? { warnings } : {}),
        note: "Nothing was written. Call again without dry_run to apply this.",
      });
    }

    const result = await found.handler(args, this.client);
    // Flatten before projecting, so `fields` names the attributes the caller
    // actually sees rather than the ones buried in a split.
    return markThirdPartyText(projectFields(flattenTransactions(stripEmpty(result)), fields));
  }
}

/** Turns a `period` shortcut into the `start`/`end` every handler already reads.
 *
 * Resolved here rather than in each schema for two reasons: the shortcut has to
 * mean the same thing on every date-filtered operation, and "today" depends on
 * the clock, which a schema cannot see.
 *
 * A shortcut given alongside explicit dates is refused rather than one of them
 * silently winning. The caller who sent both does not know which range they
 * asked for, and a wrong range comes back as a plausible number, not an error.
 */
function resolveDateShortcut(entity: string, operation: string, params: unknown): unknown {
  if (typeof params !== "object" || params === null) return params;
  const record = params as Record<string, unknown>;
  if (record.period === undefined) return params;
  const { period, ...rest } = record;
  if (rest.start !== undefined || rest.end !== undefined) {
    throw new ValidationError(
      `Invalid parameters for ${entity}.${operation}: period cannot be combined with start or end. ` +
        "Send the shortcut or the two dates, not both.",
    );
  }
  return { ...rest, ...resolvePeriod(period as Period, localToday()) };
}

/** Did a handler decline to act?
 *
 * A preview reports a refusal because it changes what the caller does next;
 * it does not report the handler's success counters, which are fiction when
 * every write went to the preview client.
 */
function isRefusal(outcome: unknown): boolean {
  return typeof outcome === "object" && outcome !== null && (outcome as { refused?: unknown }).refused === true;
}
