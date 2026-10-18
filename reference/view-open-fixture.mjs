import { OrderViewStore } from "./order-store.mjs";

const [path, identityJson] = process.argv.slice(2);
process.send({ kind: "starting" });
process.on("message", (message) => {
  if (message.kind !== "open") return;
  try {
    const store = new OrderViewStore(path, JSON.parse(identityJson));
    const snapshot = store.snapshot();
    store.close();
    process.send({ kind: "opened", snapshot });
  } catch (error) {
    process.send({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
