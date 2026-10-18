import { OrderSourceStore } from "./order-store.mjs";

const [path, identityJson] = process.argv.slice(2);
const store = new OrderSourceStore(path, JSON.parse(identityJson));
process.send({ kind: "ready" });
process.on("message", (message) => {
  if (message.kind === "stop") {
    store.close();
    process.exit(0);
  }
  try {
    const event = store.commit(message.order, 1000n, 4600n, message.key);
    process.send({ kind: "result", event });
  } catch (error) {
    process.send({
      kind: "result",
      error: error instanceof Error ? error.message : "write failed",
    });
  }
});
