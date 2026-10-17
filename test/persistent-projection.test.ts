import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  contextHeaders,
  fetchObservation,
  Issuer,
  type Mapping,
  ObservationError,
  observe,
  parseContext,
  type Representation,
  Snapshot,
  sourceKey,
  Verifier,
} from "../src/index.js";

const ISSUER = "https://orders.example";
const DOMAIN = "https://orders.example/domains/orders";
const VIEW_AUDIENCE = "https://orders-view.example/causal";
const SUBJECT = "tenant-example";
const TARGET = "/orders";
const CLOCK = 100n;

type SourceEvent = Readonly<{
  id: string;
  position: string;
  order: string;
  issuedAt: string;
  expiresAt: string;
  evidence: string;
}>;
type SourceState = Readonly<{
  nextPosition: string;
  events: readonly SourceEvent[];
}>;
type ProjectionState = Readonly<{
  frontier: string;
  lineage: "known" | "unknown";
  orders: readonly string[];
  applied: readonly string[];
  pending: readonly SourceEvent[];
}>;

const sourceInitial = (): SourceState => ({ nextPosition: "1", events: [] });
const projectionInitial = (): ProjectionState => ({
  frontier: "0",
  lineage: "known",
  orders: [],
  applied: [],
  pending: [],
});

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") assert.fail(`durable state lacks string ${name}`);
  return value;
}

function values(value: unknown, name: string): unknown[] {
  assert.ok(Array.isArray(value), `durable state lacks array ${name}`);
  return value;
}

function sourceEvent(value: unknown): SourceEvent {
  const event = object(value);
  return {
    id: text(event.id, "id"),
    position: text(event.position, "position"),
    order: text(event.order, "order"),
    issuedAt: text(event.issuedAt, "issuedAt"),
    expiresAt: text(event.expiresAt, "expiresAt"),
    evidence: text(event.evidence, "evidence"),
  };
}

function sourceState(value: unknown): SourceState {
  const state = object(value);
  return {
    nextPosition: text(state.nextPosition, "nextPosition"),
    events: values(state.events, "events").map(sourceEvent),
  };
}

function projectionState(value: unknown): ProjectionState {
  const state = object(value);
  const lineage = text(state.lineage, "lineage");
  if (lineage !== "known" && lineage !== "unknown")
    assert.fail("durable state has invalid lineage");
  const orders = values(state.orders, "orders").map((value) => text(value, "order"));
  const applied = values(state.applied, "applied").map((value) => text(value, "applied event"));
  return {
    frontier: text(state.frontier, "frontier"),
    lineage,
    orders,
    applied,
    pending: values(state.pending, "pending").map(sourceEvent),
  };
}

/** A test-only atomic-file store. A returned document is the one snapshot used for bytes and lineage. */
class AtomicFile<T> {
  readonly #path: string;
  readonly #parse: (value: unknown) => T;
  readonly #initial: () => T;

  constructor(directory: string, name: string, parse: (value: unknown) => T, initial: () => T) {
    this.#path = join(directory, name);
    this.#parse = parse;
    this.#initial = initial;
  }

  async load(): Promise<T> {
    try {
      return this.#parse(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.#initial();
      throw error;
    }
  }

  async replace(value: T): Promise<void> {
    await mkdir(resolve(this.#path, ".."), { recursive: true });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, this.#path);
  }
}

class SourceService {
  readonly #state: AtomicFile<SourceState>;
  readonly #issuer: Issuer;

  constructor(directory: string, key: KeyObject) {
    this.#state = new AtomicFile(directory, "source.json", sourceState, sourceInitial);
    this.#issuer = new Issuer(ISSUER, "persistent-demo", key, new Set([DOMAIN]), 3600n);
  }

  async commit(order: string, interruptAfterSourceCommit = false): Promise<SourceEvent> {
    assert.match(order, /^[a-z0-9-]+$/);
    const state = await this.#state.load();
    const position = BigInt(state.nextPosition);
    const event = {
      id: `urn:uuid:${randomUUID()}`,
      position: position.toString(),
      order,
      issuedAt: CLOCK.toString(),
      expiresAt: (CLOCK + 3600n).toString(),
      evidence: "",
    };

    // The source fact is durable before evidence exists or can be returned to a caller.
    await this.#state.replace({
      nextPosition: (position + 1n).toString(),
      events: [...state.events, event],
    });
    if (interruptAfterSourceCommit)
      throw new Error("injected interruption after durable source commit");
    return this.#persistEvidence(event);
  }

  async recoverOutbox(): Promise<readonly SourceEvent[]> {
    const state = await this.#state.load();
    const events = await Promise.all(
      state.events.map((event) => (event.evidence ? event : this.#evidenceFor(event))),
    );
    if (events.some((event, index) => event !== state.events[index]))
      await this.#state.replace({ ...state, events });
    return events;
  }

  async #persistEvidence(event: SourceEvent): Promise<SourceEvent> {
    const committed = this.#evidenceFor(event);
    const recovered = await this.#state.load();
    assert.equal(
      recovered.events.at(-1)?.id,
      event.id,
      "source fact changed before evidence persistence",
    );
    await this.#state.replace({
      ...recovered,
      events: [...recovered.events.slice(0, -1), committed],
    });
    return committed;
  }

  #evidenceFor(event: SourceEvent): SourceEvent {
    const evidence = this.#issuer.issueCommitted(
      {
        subject: SUBJECT,
        audiences: [VIEW_AUDIENCE],
        domain: DOMAIN,
        position: BigInt(event.position),
        issuedAt: BigInt(event.issuedAt),
        expiresAt: BigInt(event.expiresAt),
        evidenceId: event.id,
      },
      CLOCK,
    );
    return { ...event, evidence };
  }

  async events(): Promise<readonly SourceEvent[]> {
    return (await this.#state.load()).events;
  }
}

class ProjectionService {
  readonly #state: AtomicFile<ProjectionState>;
  readonly #verifier: Verifier;

  constructor(directory: string, key: KeyObject) {
    this.#state = new AtomicFile(directory, "projection.json", projectionState, projectionInitial);
    this.#verifier = new Verifier(VIEW_AUDIENCE, [
      {
        issuer: ISSUER,
        keys: new Map([["persistent-demo", key]]),
        domains: new Set([DOMAIN]),
        maxLifetimeSeconds: 3600n,
        clockSkewSeconds: 0n,
      },
    ]);
  }

  async deliver(event: SourceEvent): Promise<void> {
    const evidence = this.#verifier.verify(event.evidence, SUBJECT, CLOCK);
    assert.equal(evidence.domain, DOMAIN);
    assert.equal(evidence.position, event.position);
    const state = await this.#state.load();
    if (
      state.applied.includes(event.id) ||
      state.pending.some((candidate) => candidate.id === event.id)
    )
      return;
    const expected = BigInt(state.frontier) + 1n;
    if (BigInt(event.position) !== expected) {
      assert.ok(
        BigInt(event.position) > expected,
        "a missing lower event cannot be silently accepted",
      );
      await this.#state.replace({ ...state, pending: [...state.pending, event] });
      return;
    }
    const applied = [...state.applied],
      orders = [...state.orders];
    let frontier = BigInt(state.frontier),
      current = event;
    const pending = [...state.pending];
    while (true) {
      assert.equal(BigInt(current.position), frontier + 1n);
      frontier += 1n;
      applied.push(current.id);
      orders.push(current.order);
      const next = pending.find((candidate) => BigInt(candidate.position) === frontier + 1n);
      if (!next) break;
      pending.splice(pending.indexOf(next), 1);
      current = next;
    }
    await this.#state.replace({
      ...state,
      frontier: frontier.toString(),
      orders,
      applied,
      pending,
    });
  }

  async snapshot(): Promise<Snapshot<Representation>> {
    const state = await this.#state.load();
    // `state` is one atomically replaced document: representation bytes and frontier share this cut.
    const body = Buffer.from(JSON.stringify({ orders: state.orders, frontier: state.frontier }));
    const mapping: Mapping = {
      kind: "relevant",
      frontiers: [state.lineage === "known" ? BigInt(state.frontier) : "unknown"],
      progressPossible: true,
    };
    return new Snapshot(
      TARGET,
      { status: 200, headers: new Headers({ "Content-Type": "application/json" }), body },
      "persistent-file/v1",
      "orders/v1",
      new Map([[sourceKey(ISSUER, DOMAIN), mapping]]),
    );
  }

  async state(): Promise<ProjectionState> {
    return this.#state.load();
  }

  /** Simulates a recovered projection whose representation survived but source lineage did not. */
  async loseLineage(): Promise<void> {
    const state = await this.#state.load();
    await this.#state.replace({ ...state, lineage: "unknown" });
  }

  async constrainedObservation(request: Pick<Request, "method" | "headers">): Promise<Response> {
    try {
      return await observe({
        request,
        target: TARGET,
        designatedObservation: true,
        verifier: this.#verifier,
        subject: SUBJECT,
        authorize: () => true,
        clock: () => CLOCK,
        read: () => this.snapshot(),
      });
    } catch (error) {
      if (error instanceof ObservationError) return error.toResponse();
      throw error;
    }
  }
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index],
      value = request.rawHeaders[index + 1];
    assert.ok(typeof name === "string");
    assert.ok(typeof value === "string");
    headers.append(name, value);
  }
  return headers;
}

function send(response: ServerResponse, status: number, headers: Headers, body: Uint8Array): void {
  response.writeHead(status, Object.fromEntries(headers));
  response.end(body);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): void {
  server.closeAllConnections();
  server.close();
}

function sourceHttp(source: SourceService): Server {
  return createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.startsWith("/orders/")) {
      response.writeHead(404).end();
      return;
    }
    const order = request.url.slice("/orders/".length);
    void source
      .commit(order)
      .then((event) => {
        const headers = contextHeaders([event.evidence]);
        headers.set("Content-Type", "application/json");
        send(
          response,
          201,
          headers,
          Buffer.from(JSON.stringify({ order, position: event.position })),
        );
      })
      .catch(() => response.writeHead(500).end());
  });
}

function projectionHttp(projection: ProjectionService): Server {
  return createServer((request, response) => {
    if (request.url !== TARGET) {
      response.writeHead(404).end();
      return;
    }
    void projection
      .constrainedObservation({ method: request.method ?? "GET", headers: requestHeaders(request) })
      .then(async (result) =>
        send(response, result.status, result.headers, Buffer.from(await result.arrayBuffer())),
      )
      .catch(() => response.writeHead(500).end());
  });
}

test("two durable local services reject stale reads, recover, and preserve source order", async (context) => {
  const root = join(tmpdir(), `causalweb-persistent-demo-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  context.after(async () => {
    assert.equal(resolve(root, ".."), resolve(tmpdir()));
    assert.ok(root.startsWith(join(resolve(tmpdir()), "causalweb-persistent-demo-")));
    await rm(root, { recursive: true, force: true });
  });

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let source = new SourceService(join(root, "source"), privateKey);
  let projection = new ProjectionService(join(root, "projection"), publicKey);
  let sourceServer = sourceHttp(source),
    projectionServer = projectionHttp(projection);
  const sourceOrigin = await listen(sourceServer),
    projectionOrigin = await listen(projectionServer);
  context.after(() => {
    close(sourceServer);
    close(projectionServer);
  });

  const operation = await fetch(`${sourceOrigin}/orders/first`, { method: "POST" });
  assert.equal(operation.status, 201);
  const [firstToken] = parseContext([operation.headers.get("causal-context") ?? ""]);
  assert.ok(typeof firstToken === "string");
  const [first] = await source.events();
  assert.ok(first);

  const stale = await fetchObservation(`${projectionOrigin}${TARGET}`, [firstToken], {
    authenticated: () => true,
  });
  assert.equal(stale.kind, "causal-failure");
  if (stale.kind === "causal-failure")
    assert.equal(stale.problem.outcomes[0]?.outcome, "unsatisfied");

  await projection.deliver(first);
  const confirmed = await fetchObservation(`${projectionOrigin}${TARGET}`, [firstToken], {
    authenticated: () => true,
  });
  assert.equal(confirmed.kind, "confirmed");
  assert.deepEqual(await confirmed.response.json(), { orders: ["first"], frontier: "1" });

  const secondResponse = await fetch(`${sourceOrigin}/orders/second`, { method: "POST" });
  const thirdResponse = await fetch(`${sourceOrigin}/orders/third`, { method: "POST" });
  const [secondToken] = parseContext([secondResponse.headers.get("causal-context") ?? ""]);
  const [thirdToken] = parseContext([thirdResponse.headers.get("causal-context") ?? ""]);
  assert.ok(typeof secondToken === "string");
  assert.ok(typeof thirdToken === "string");
  const events = await source.events();
  const second = events.find((event) => event.evidence === secondToken),
    third = events.find((event) => event.evidence === thirdToken);
  assert.ok(second && third);

  await projection.deliver(third);
  assert.equal((await projection.state()).frontier, "1");
  const delayed = await fetchObservation(`${projectionOrigin}${TARGET}`, [thirdToken], {
    authenticated: () => true,
  });
  assert.equal(delayed.kind, "causal-failure");
  await projection.deliver(second);
  assert.deepEqual(await projection.state(), {
    frontier: "3",
    lineage: "known",
    orders: ["first", "second", "third"],
    applied: [first.id, second.id, third.id],
    pending: [],
  });
  const covered = await fetchObservation(`${projectionOrigin}${TARGET}`, [thirdToken], {
    authenticated: () => true,
  });
  assert.equal(covered.kind, "confirmed");

  const beforeDuplicate = await projection.state();
  await projection.deliver(third);
  assert.deepEqual(
    await projection.state(),
    beforeDuplicate,
    "duplicate delivery changed durable state",
  );
  const last = third.evidence.at(-1);
  assert.ok(last);
  await assert.rejects(
    projection.deliver({
      ...third,
      evidence: `${third.evidence.slice(0, -1)}${last === "A" ? "B" : "A"}`,
    }),
  );
  assert.equal((await projection.state()).frontier, "3", "forged propagation advanced a frontier");

  await assert.rejects(
    source.commit("recovered", true),
    /injected interruption after durable source commit/,
  );
  assert.equal(
    (await source.events()).at(-1)?.evidence,
    "",
    "interruption unexpectedly returned evidence",
  );

  close(sourceServer);
  close(projectionServer);
  source = new SourceService(join(root, "source"), privateKey);
  projection = new ProjectionService(join(root, "projection"), publicKey);
  sourceServer = sourceHttp(source);
  projectionServer = projectionHttp(projection);
  const restartedSource = await listen(sourceServer),
    restartedProjection = await listen(projectionServer);
  assert.equal((await source.events()).length, 4, "source restart lost committed outbox facts");
  const afterRestart = await fetchObservation(`${restartedProjection}${TARGET}`, [thirdToken], {
    authenticated: () => true,
  });
  assert.equal(afterRestart.kind, "confirmed");
  const recovered = await source.recoverOutbox();
  const fourth = recovered.at(-1);
  assert.ok(fourth?.evidence, "outbox recovery did not issue missing evidence");
  await projection.deliver(fourth);
  const recoveredObservation = await fetchObservation(
    `${restartedProjection}${TARGET}`,
    [fourth.evidence],
    {
      authenticated: () => true,
    },
  );
  assert.equal(recoveredObservation.kind, "confirmed");
  if (recoveredObservation.kind === "confirmed")
    assert.deepEqual(await recoveredObservation.response.json(), {
      orders: ["first", "second", "third", "recovered"],
      frontier: "4",
    });

  // Representation bytes survived, but this projection can no longer establish their source lineage.
  await projection.loseLineage();
  const unknown = await fetchObservation(`${restartedProjection}${TARGET}`, [fourth.evidence], {
    authenticated: () => true,
  });
  assert.equal(unknown.kind, "causal-failure");
  if (unknown.kind === "causal-failure")
    assert.equal(unknown.problem.outcomes[0]?.outcome, "unknown");

  close(projectionServer);
  projection = new ProjectionService(join(root, "projection"), publicKey);
  projectionServer = projectionHttp(projection);
  const restartedWithoutLineage = await listen(projectionServer);
  const stillUnknown = await fetchObservation(
    `${restartedWithoutLineage}${TARGET}`,
    [fourth.evidence],
    {
      authenticated: () => true,
    },
  );
  assert.equal(stillUnknown.kind, "causal-failure");
  if (stillUnknown.kind === "causal-failure")
    assert.equal(stillUnknown.problem.outcomes[0]?.outcome, "unknown");
  assert.equal(restartedSource.startsWith("http://127.0.0.1:"), true);
});
