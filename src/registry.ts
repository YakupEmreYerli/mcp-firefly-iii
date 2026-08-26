import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Config } from "./config.js";
import type { FireflyClient } from "./firefly.js";
import { EntityType, type Access } from "./types.js";
import {
  EntityNotAvailableError,
  OperationNotFoundError,
  ReadOnlyModeError,
  ValidationError,
} from "./errors.js";
import { projectFields, stripEmpty } from "./projection.js";

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
      .filter(([, op]) => !this.isWriteBlocked(op))
      .sort(([a], [b]) => a.localeCompare(b));
  }

  private isWriteBlocked(operation: Operation): boolean {
    return this.config.readOnly && operation.access === "write";
  }

  private lookup(entity: string, operation: string): [EntityModule, Operation] {
    const entityType = toEntityType(entity);
    const module = this.modules.get(entityType);
    if (!module) throw new EntityNotAvailableError(`No entity module for: ${entity}`);

    const found = module.operations[operation];
    if (!found) throw new OperationNotFoundError(`Unknown operation: ${entity}.${operation}`);

    if (this.isWriteBlocked(found)) {
      throw new ReadOnlyModeError(
        `'${entity}.${operation}' writes to Firefly III and the server is running with FIREFLY_READ_ONLY enabled.`,
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

  operationCatalogue(): string {
    return this.entityModules()
      .map((module) => {
        const names = this.visibleOperations(module).map(([name]) => name);
        return `  ${module.entity}: ${names.join(", ")} — ${module.hint}`;
      })
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
  ): Promise<unknown> {
    const [, found] = this.lookup(entity, operation);

    const parsed = found.input.safeParse(params ?? {});
    if (!parsed.success) {
      throw new ValidationError(
        `Invalid parameters for ${entity}.${operation}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    const result = await found.handler(parsed.data, this.client);
    return projectFields(stripEmpty(result), fields);
  }
}
