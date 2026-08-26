/** Base for every error this server raises itself. */
export class FireflyMcpError extends Error {}

export class RegistryError extends FireflyMcpError {}
export class EntityNotAvailableError extends FireflyMcpError {}
export class OperationNotFoundError extends FireflyMcpError {}
export class ValidationError extends FireflyMcpError {}
export class ReadOnlyModeError extends FireflyMcpError {}

/** An error response from Firefly III.
 *
 * Carries Firefly's own message rather than a generic HTTP status text: the
 * message is what tells the caller which field was wrong.
 */
export class FireflyApiError extends FireflyMcpError {
  readonly status: number;
  readonly errors: Record<string, unknown>;

  constructor(status: number, message: string, errors: Record<string, unknown> = {}) {
    super(`${status} – ${message}`);
    this.status = status;
    this.errors = errors;
  }

  static async fromResponse(response: Response): Promise<FireflyApiError> {
    let message = "Unknown error";
    let errors: Record<string, unknown> = {};

    const text = await response.text();
    try {
      const payload: unknown = JSON.parse(text);
      if (isRecord(payload)) {
        if (payload.message !== undefined) message = String(payload.message);
        if (isRecord(payload.errors)) {
          errors = payload.errors;
        }
      }
    } catch {
      // Not JSON — fall back to the raw body below.
    }

    if (message === "Unknown error" && text) message = text;
    return new FireflyApiError(response.status, message, errors);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
