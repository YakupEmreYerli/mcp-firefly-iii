import type { IncomingMessage } from "node:http";

/** Bodies above this are refused unread. An MCP request is kilobytes; anything
 * larger is a mistake or an attempt to exhaust memory.
 *
 * The limit lives here rather than beside one reader because the OAuth routes
 * are reached before any credential is checked, and they used a second reader
 * that had no limit at all: `/mcp` refused a megabyte while `/oauth/register`
 * buffered whatever a stranger sent. One rule, one place. */
export const MAX_BODY_BYTES = 1_048_576;

/** Read a request body as text, refusing one that is too large.
 *
 * Rejects rather than truncating: a half-read body parses into something the
 * caller did not send, which is worse than a refusal.
 */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
