import { handleFastifyObservation } from "@causalweb/sdk/fastify";
import fastify from "fastify";

const app = fastify();
app.get("/view", async (request, reply) => {
  if (request.headers["causal-require"] === undefined) return reply.send({ ordinary: true });
  // Package-consumption type proof: real observer options belong to an application.
  void handleFastifyObservation;
  return reply.code(501).send();
});

await app.close();
