import type { IncomingMessage, ServerResponse } from "node:http";
import { ObservationError } from "../protocol/error.js";
import { type ObservationOptions, observe } from "./observation.js";

/** Preserve the received field-line sequence; Node's normalized `headers` object
 * loses duplicate Causal-Require lines and therefore cannot be used here. */
export function headersFromIncoming(request: Pick<IncomingMessage, "rawHeaders">): Headers {
  const headers = new Headers();
  if (request.rawHeaders.length % 2 !== 0)
    throw new TypeError("rawHeaders must be name/value pairs");
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name === undefined || value === undefined)
      throw new TypeError("rawHeaders must be name/value pairs");
    headers.append(name, value);
  }
  return headers;
}

export function hasCausalRequirement(request: Pick<IncomingMessage, "rawHeaders">): boolean {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "causal-require") return true;
  }
  return false;
}

/** Write a Fetch response without collapsing separate Set-Cookie fields. */
export async function writeFetchResponse(
  response: Response,
  destination: Pick<ServerResponse, "headersSent" | "setHeader" | "writeHead" | "end">,
): Promise<void> {
  if (destination.headersSent) throw new Error("cannot write a Causal Web response after headers");
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") destination.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) destination.setHeader("set-cookie", cookies);
  destination.writeHead(response.status);
  destination.end(response.body === null ? undefined : Buffer.from(await response.arrayBuffer()));
}

export interface NodeObservationOptions extends Omit<ObservationOptions, "request"> {
  /** Receives adapter failures for local diagnostics. The response is still the
   * safe, marker-free ordinary error from ObservationError.toResponse(). */
  readonly onLocalError?: (error: ObservationError) => void;
}

/**
 * Handle an explicitly causal Node HTTP request. Returns false for an ordinary
 * request so a host can route it normally; this adapter never creates evidence
 * and never waits for a projection to catch up.
 */
export async function handleNodeObservation(
  request: IncomingMessage,
  response: ServerResponse,
  options: NodeObservationOptions,
): Promise<boolean> {
  if (!hasCausalRequirement(request)) return false;
  let result: Response;
  try {
    result = await observe({
      ...options,
      request: { method: request.method ?? "GET", headers: headersFromIncoming(request) },
    });
  } catch (error) {
    if (!(error instanceof ObservationError)) throw error;
    try {
      options.onLocalError?.(error);
    } catch {
      // Diagnostic hooks cannot change the protocol response or leak an exception.
    }
    result = error.toResponse();
  }
  await writeFetchResponse(result, response);
  return true;
}
