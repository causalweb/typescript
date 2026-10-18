import assert from "node:assert/strict";
import { test } from "vitest";
import { absoluteUri, httpsIssuer } from "../src/uri.js";

test("generated RFC 3986 components remain exact and reject malformed mutations", () => {
  let state = 0x3986;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const pieces = ["a", "Z", "0", "-", "~", ":", "@", "/", "%2F", "%23", "!", ";", "="];
  const queryPieces = [...pieces, "?"];
  const component = (alphabet: string[]) => {
    let result = "";
    for (let i = 0, length = next() % 12; i < length; i++) {
      result += alphabet[next() % alphabet.length];
    }
    return result;
  };

  for (let i = 0; i < 512; i++) {
    const path = component(pieces);
    const query = component(queryPieces);
    const uri = `https://example.test/${path}?${query}`;
    assert.equal(absoluteUri(uri), true, uri);
    assert.equal(httpsIssuer(uri), true, uri);
    for (const invalid of [`${uri}#`, `${uri}#fragment`, `${uri}%`, `${uri}\n`, `${uri}\u2028`]) {
      assert.equal(absoluteUri(invalid), false, invalid);
      assert.equal(httpsIssuer(invalid), false, invalid);
    }
    const opaque = `urn:test:${path}?${query}`;
    assert.equal(absoluteUri(opaque), true, opaque);
    assert.equal(httpsIssuer(opaque), false, opaque);
  }
});

test("authority boundaries distinguish generic URI syntax from HTTPS issuer policy", () => {
  for (const authority of [
    "example.test:443",
    "user:pass@example.test",
    "[::1]:443",
    "[v1.a:b]",
    "example%2Etest",
  ]) {
    assert.equal(absoluteUri(`https://${authority}/orders`), true, authority);
    assert.equal(httpsIssuer(`https://${authority}/orders`), true, authority);
  }
  for (const authority of ["", ":443", "user@", "user@:443"]) {
    assert.equal(absoluteUri(`https://${authority}/orders`), true, authority);
    assert.equal(httpsIssuer(`https://${authority}/orders`), false, authority);
  }
  for (const authority of [
    "[::1",
    "[]",
    "[v1.]",
    "[fe80::1%25eth0]",
    "[::1]suffix",
    "example.test:abc",
    "example.test:80:90",
    "user@other@example.test",
    "example%GG.test",
  ]) {
    assert.equal(absoluteUri(`https://${authority}/orders`), false, authority);
    assert.equal(httpsIssuer(`https://${authority}/orders`), false, authority);
  }
});
