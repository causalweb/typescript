import { invalid } from "./error.js";

export class Decimal {
  constructor(readonly text: string) {
    Object.freeze(this);
  }
}
export type Json = null | boolean | string | Decimal | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

// Preserve numeric tokens until range/integrality checks; JSON.parse would round them.
export function parseObject(bytes: Uint8Array, maxDepth: number): JsonObject {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid();
  }
  if (text.startsWith("\uFEFF")) invalid();
  let offset = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/.test(text[offset] ?? "!") && offset < text.length) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === "\\") {
        offset++;
        continue;
      }
      if (character === '"') {
        let value: string;
        try {
          value = JSON.parse(text.slice(start, offset)) as string;
        } catch {
          return invalid();
        }
        for (let i = 0; i < value.length; i++) {
          const unit = value.charCodeAt(i);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
          } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
        }
        return value;
      }
    }
    return invalid();
  };
  const value = (depth: number): Json => {
    if (depth > maxDepth) invalid();
    whitespace();
    const first = text[offset];
    if (first === '"') return string();
    if (first === "{") {
      offset++;
      whitespace();
      const object = Object.create(null) as JsonObject;
      const names = new Set<string>();
      if (text[offset] === "}") {
        offset++;
        return object;
      }
      while (true) {
        whitespace();
        if (text[offset] !== '"') invalid();
        const key = string();
        if (names.has(key)) invalid();
        names.add(key);
        whitespace();
        if (text[offset++] !== ":") invalid();
        object[key] = value(depth + 1);
        whitespace();
        const next = text[offset++];
        if (next === "}") return object;
        if (next !== ",") invalid();
      }
    }
    if (first === "[") {
      offset++;
      whitespace();
      const array: Json[] = [];
      if (text[offset] === "]") {
        offset++;
        return array;
      }
      while (true) {
        array.push(value(depth + 1));
        whitespace();
        const next = text[offset++];
        if (next === "]") return array;
        if (next !== ",") invalid();
      }
    }
    for (const [literal, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return result;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(offset),
    )?.[0];
    if (number === undefined) return invalid();
    offset += number.length;
    return new Decimal(number);
  };
  const result = value(1);
  whitespace();
  if (offset !== text.length) invalid();
  return object(result);
}

export function object(value: Json | undefined): JsonObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Decimal
  )
    return invalid();
  return value;
}

export function nonempty(value: Json | undefined): string {
  if (typeof value !== "string" || value.length === 0) return invalid();
  return value;
}

export function integer(value: Json | undefined, maximum: bigint): bigint {
  if (!(value instanceof Decimal)) return invalid();
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(value.text);
  if (!match) return invalid();
  let digits = (match[2]! + (match[3] ?? "")).replace(/^0+/, "");
  if (!digits) return 0n;
  if (match[1] === "-") return invalid();
  const exponent = BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length);
  if (exponent >= 0n) {
    if (exponent > 20n || BigInt(digits.length) + exponent > 20n) return invalid();
    digits += "0".repeat(Number(exponent));
  } else {
    const removed = -exponent;
    if (removed >= BigInt(digits.length)) return invalid();
    const end = digits.length - Number(removed);
    if (!/^0*$/.test(digits.slice(end))) return invalid();
    digits = digits.slice(0, end);
  }
  const result = BigInt(digits);
  if (result > maximum) return invalid();
  return result;
}
