import type { FastifyReply, FastifyRequest } from "fastify";
import {
  handleNodeObservation,
  hasCausalRequirement,
  type NodeObservationOptions,
} from "./node.js";

/**
 * Handle an explicit causal Fastify route. A normal request returns false and
 * remains in Fastify's normal lifecycle. A causal request is hijacked before
 * its response is written so Fastify cannot serialize a second response.
 */
export async function handleFastifyObservation(
  request: FastifyRequest,
  reply: FastifyReply,
  options: NodeObservationOptions,
): Promise<boolean> {
  if (!hasCausalRequirement(request.raw)) return false;
  reply.hijack();
  await handleNodeObservation(request.raw, reply.raw, options);
  return true;
}
