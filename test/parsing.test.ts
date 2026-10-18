import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "vitest";
import {
  DEFAULT_LIMITS,
  Issuer,
  ProtocolError,
  position,
  serializeContext,
  Verifier,
} from "../src/index.js";
import { integer, parseObject } from "../src/json.js";
import { absoluteUri, httpsIssuer } from "../src/uri.js";

test("positions and URIs reject control and Unicode line terminators", () => {
  for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029", " ", "\t", "\0"]) {
    assert.throws(() => position(`5${suffix}`), ProtocolError);
    assert.equal(absoluteUri(`urn:test:a${suffix}`), false);
    assert.equal(httpsIssuer(`https://issuer.example${suffix}`), false);
    if (suffix !== " ") assert.throws(() => serializeContext([`token${suffix}`]), ProtocolError);
  }
});

test("generic URIs preserve identifiers and do not repair invalid syntax", () => {
  for (const uri of [
    "urn:test:opaque",
    "HTTPS://EXAMPLE.COM/a%2Fb?x=y%23z",
    "https://[::1]/path",
    "https://[v1.host]/",
    "scheme:",
    "scheme:/a",
  ])
    assert.equal(absoluteUri(uri), true, uri);
  for (const uri of [
    "relative/path",
    "https://host/%GG",
    "https://host/back\\slash",
    "https://host/a b",
    "https://[bad-ip]/",
    "https://host:bad/",
    "https://host/#a#b",
    "https://host/#fragment",
    "https://host/#",
    "urn:test:a#fragment",
    "https://host/é",
  ])
    assert.equal(absoluteUri(uri), false, uri);
});

test("fragment-free URI syntax applies to issuer and configured identities", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  assert.equal(absoluteUri("urn:test:a%23fragment"), true);
  assert.equal(httpsIssuer("HTTPS://ISSUER.EXAMPLE/a%23part"), true);
  for (const issuer of ["https://issuer.example/#", "https://issuer.example/#fragment"]) {
    assert.equal(httpsIssuer(issuer), false);
    assert.throws(
      () =>
        new Verifier("audience", [
          {
            issuer,
            keys: new Map([["test", publicKey]]),
            domains: new Set(["urn:test:domain"]),
            maxLifetimeSeconds: 1000n,
            clockSkewSeconds: 0n,
          },
        ]),
      { code: "invalid-configuration" },
    );
    assert.throws(
      () => new Issuer(issuer, "test", privateKey, new Set(["urn:test:domain"]), 1000n),
      { code: "invalid-configuration" },
    );
  }
  assert.throws(
    () =>
      new Issuer(
        "https://issuer.example",
        "test",
        privateKey,
        new Set(["urn:test:domain#"]),
        1000n,
      ),
    { code: "invalid-configuration" },
  );
});

test("required limits cannot be omitted by JavaScript callers", () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const trust = {
    issuer: "https://issuer.example",
    keys: new Map([["test", publicKey]]),
    domains: new Set(["urn:test:domain"]),
    maxLifetimeSeconds: 1000n,
    clockSkewSeconds: 0n,
  };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const limits = { ...DEFAULT_LIMITS } as Record<string, number>;
    delete limits[key];
    assert.throws(
      () => new Verifier("audience", [trust], limits as unknown as typeof DEFAULT_LIMITS),
      { code: "invalid-configuration" },
    );
  }
});

test("JSON depth, Unicode scalars, and exact integer magnitude are checked", () => {
  for (const json of ['{"x":"\\uD800"}', '{"x":"\\uDC00"}', '{"x":NaN}', '{"x":[[[[1]]]]}']) {
    assert.throws(() => parseObject(Buffer.from(json), 4), ProtocolError, json);
  }
  const object = parseObject(
    Buffer.from('{"x":9007199254740991,"y":9007199254740990.5,"emoji":"\\uD83D\\uDE00"}'),
    4,
  );
  assert.equal(integer(object.x, 9007199254740991n), 9007199254740991n);
  assert.throws(() => integer(object.y, 9007199254740991n), ProtocolError);
  assert.equal(object.emoji, "😀");
});

test("issuer policy and key references are not mutable JavaScript properties", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const domains = new Set(["urn:test:domain"]);
  const issuer = new Issuer("https://issuer.example", "test", keys.privateKey, domains, 1000n);
  domains.clear();
  assert.deepEqual(Object.keys(issuer), []);
  assert.ok(Object.isFrozen(issuer));
  assert.throws(() => Object.assign(issuer, { issuer: "https://attacker.example" }), TypeError);
  const verifier = new Verifier("audience", [
    {
      issuer: "https://issuer.example",
      keys: new Map([["test", keys.publicKey]]),
      domains: new Set(["urn:test:domain"]),
      maxLifetimeSeconds: 1000n,
      clockSkewSeconds: 0n,
    },
  ]);
  const token = issuer.issueCommitted(
    {
      subject: "tenant",
      audiences: ["audience"],
      domain: "urn:test:domain",
      position: 0n,
      issuedAt: 1n,
      expiresAt: 1000n,
    },
    100n,
  );
  assert.equal(verifier.verify(token, "tenant", 100n).position, "0");
});
