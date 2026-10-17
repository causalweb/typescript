import { KeyObject, randomUUID, sign, verify } from "node:crypto";
import { invalid, ProtocolError } from "./error.js";
import { integer, type JsonObject, nonempty, object, parseObject } from "./json.js";
import { absoluteUri, httpsIssuer } from "./uri.js";

export const PROFILE = "https://github.com/causalweb/spec/profiles/prefix-01";
export const CLAIM = "https://github.com/causalweb/spec/claims/v1";
export const MAX_DATE = 9007199254740991n;
export const MAX_POSITION = 18446744073709551615n;

export interface Limits {
  readonly maxRequirements: number;
  readonly maxHeaderBytes: number;
  readonly maxTokenBytes: number;
  readonly maxDecodedBytes: number;
  readonly maxJsonDepth: number;
}
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxRequirements: 16,
  maxHeaderBytes: 16384,
  maxTokenBytes: 8192,
  maxDecodedBytes: 8192,
  maxJsonDepth: 32,
});

export function validateLimits(limits: Limits): void {
  const fields: readonly (keyof Limits)[] = [
    "maxRequirements",
    "maxHeaderBytes",
    "maxTokenBytes",
    "maxDecodedBytes",
    "maxJsonDepth",
  ];
  if (
    !limits ||
    typeof limits !== "object" ||
    fields.some((key) => !Number.isSafeInteger(limits[key]) || limits[key] <= 0) ||
    limits.maxJsonDepth < 2 ||
    limits.maxJsonDepth > 64
  )
    throw new ProtocolError("invalid-configuration");
}

export function position(value: string): bigint {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 20 ||
    /[^0-9]/.test(value) ||
    (value.length > 1 && value.startsWith("0"))
  )
    return invalid();
  const result = BigInt(value);
  if (result > MAX_POSITION) return invalid();
  return result;
}

function decode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return invalid();
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.toString("base64url") !== segment) return invalid();
  return decoded;
}

function common(claims: JsonObject, maximumLifetime: bigint, skew: bigint, now: bigint): void {
  if (!httpsIssuer(nonempty(claims.iss))) invalid();
  nonempty(claims.sub);
  nonempty(claims.jti);
  if (Object.hasOwn(claims, "nbf")) invalid();
  const audiences =
    typeof claims.aud === "string"
      ? [nonempty(claims.aud)]
      : Array.isArray(claims.aud)
        ? claims.aud.map(nonempty)
        : invalid();
  if (audiences.length === 0 || new Set(audiences).size !== audiences.length) invalid();
  const iat = integer(claims.iat, MAX_DATE),
    exp = integer(claims.exp, MAX_DATE);
  if (iat >= exp || exp - iat > maximumLifetime || iat > now + skew) invalid();
  const causal = object(claims[CLAIM]);
  if (integer(causal.v, 1n) !== 1n || causal.commit !== "stable") invalid();
  const profile = nonempty(causal.profile);
  if (!absoluteUri(profile) || !absoluteUri(nonempty(causal.domain))) invalid();
  const value = nonempty(causal.position);
  if (profile === PROFILE) position(value);
}

export interface IssuerTrust {
  readonly issuer: string;
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly domains: ReadonlySet<string>;
  readonly maxLifetimeSeconds: bigint;
  readonly clockSkewSeconds: bigint;
}

class CheckedEvidence {
  readonly #claims: JsonObject;
  readonly #skew: bigint;
  constructor(claims: JsonObject, skew: bigint) {
    this.#claims = claims;
    this.#skew = skew;
    Object.freeze(this);
  }
  get issuer(): string {
    return this.#claims.iss as string;
  }
  get domain(): string {
    return object(this.#claims[CLAIM]).domain as string;
  }
  get profile(): string {
    return object(this.#claims[CLAIM]).profile as string;
  }
  get position(): string {
    return object(this.#claims[CLAIM]).position as string;
  }
  get expiresAt(): bigint {
    return integer(this.#claims.exp, MAX_DATE);
  }
  expired(now: bigint): boolean {
    if (typeof now !== "bigint" || now < 0n) throw new ProtocolError("invalid-configuration");
    return now >= this.expiresAt + this.#skew;
  }

  static retainedContextIndices(
    evidence: readonly VerifiedEvidence[],
    now: bigint,
    requiredUsableUntil: bigint,
  ): readonly number[] {
    if (
      typeof now !== "bigint" ||
      now < 0n ||
      typeof requiredUsableUntil !== "bigint" ||
      requiredUsableUntil < now ||
      evidence.some((item) => !(item instanceof CheckedEvidence))
    )
      throw new ProtocolError("invalid-configuration");
    return Object.freeze(
      evidence.flatMap((dominated, index) =>
        evidence.some(
          (candidate, candidateIndex) =>
            candidateIndex !== index &&
            CheckedEvidence.#dominates(candidate, dominated, now, requiredUsableUntil) &&
            (position(candidate.position) > position(dominated.position) || candidateIndex < index),
        )
          ? []
          : [index],
      ),
    );
  }

  static #dominates(
    candidate: CheckedEvidence,
    dominated: CheckedEvidence,
    now: bigint,
    requiredUsableUntil: bigint,
  ): boolean {
    if (candidate.expired(now) || dominated.expired(now)) return false;
    const candidateCausal = object(candidate.#claims[CLAIM]);
    const dominatedCausal = object(dominated.#claims[CLAIM]);
    const audiences = (claims: JsonObject) => {
      const value = claims.aud;
      const values: string[] = typeof value === "string" ? [value] : (value as string[]);
      return [...values].sort();
    };
    const candidateAudiences = audiences(candidate.#claims);
    const dominatedAudiences = audiences(dominated.#claims);
    const dominates =
      candidate.#claims.iss === dominated.#claims.iss &&
      candidate.#claims.sub === dominated.#claims.sub &&
      integer(candidateCausal.v, 1n) === integer(dominatedCausal.v, 1n) &&
      candidateCausal.profile === PROFILE &&
      candidateCausal.profile === dominatedCausal.profile &&
      candidateCausal.domain === dominatedCausal.domain &&
      candidateCausal.commit === dominatedCausal.commit &&
      candidateAudiences.length === dominatedAudiences.length &&
      candidateAudiences.every((audience, index) => audience === dominatedAudiences[index]) &&
      position(candidate.position) >= position(dominated.position) &&
      candidate.expiresAt + candidate.#skew > requiredUsableUntil;
    return dominates;
  }
}
export type VerifiedEvidence = CheckedEvidence;

/**
 * Returns ordered indices of verified evidence that a carrier MUST retain.
 *
 * Verify every input under the current intended policy first, then use these indices to retain
 * the original compact evidence strings unchanged. `requiredUsableUntil` is an absolute UTC
 * second through which every retained dominant item must remain usable. The function does not
 * issue, rewrite, or validate raw evidence, and it preserves items it cannot safely omit.
 */
export function retainedContextIndices(
  evidence: readonly VerifiedEvidence[],
  now: bigint,
  requiredUsableUntil: bigint,
): readonly number[] {
  return CheckedEvidence.retainedContextIndices(evidence, now, requiredUsableUntil);
}

function p256Key(key: KeyObject, type: "public" | "private"): boolean {
  return (
    key instanceof KeyObject &&
    key.type === type &&
    key.asymmetricKeyType === "ec" &&
    key.asymmetricKeyDetails?.namedCurve === "prime256v1"
  );
}

export class Verifier {
  readonly #trusts = new Map<string, IssuerTrust>();
  readonly limits: Readonly<Limits>;
  readonly audience: string;
  constructor(audience: string, trusts: readonly IssuerTrust[], limits: Limits = DEFAULT_LIMITS) {
    validateLimits(limits);
    if (
      typeof audience !== "string" ||
      !audience ||
      Buffer.byteLength(audience) > 2048 ||
      !trusts.length
    )
      throw new ProtocolError("invalid-configuration");
    this.audience = audience;
    this.limits = Object.freeze({ ...limits });
    for (const trust of trusts) {
      if (
        !httpsIssuer(trust.issuer) ||
        this.#trusts.has(trust.issuer) ||
        !trust.keys.size ||
        [...trust.keys].some(([kid, key]) => !kid || !p256Key(key, "public")) ||
        [...trust.domains].some((domain) => !absoluteUri(domain)) ||
        typeof trust.maxLifetimeSeconds !== "bigint" ||
        trust.maxLifetimeSeconds <= 0n ||
        trust.maxLifetimeSeconds > MAX_POSITION ||
        typeof trust.clockSkewSeconds !== "bigint" ||
        trust.clockSkewSeconds < 0n ||
        trust.clockSkewSeconds > MAX_POSITION
      )
        throw new ProtocolError("invalid-configuration");
      this.#trusts.set(trust.issuer, {
        ...trust,
        keys: new Map(trust.keys),
        domains: new Set(trust.domains),
      });
    }
    Object.freeze(this);
  }

  verify(compact: string, authenticatedSubject: string, now: bigint): VerifiedEvidence {
    if (typeof now !== "bigint" || now < 0n) throw new ProtocolError("invalid-configuration");
    if (Buffer.byteLength(compact) > this.limits.maxTokenBytes)
      throw new ProtocolError("too-large");
    const segments = compact.split(".");
    if (segments.length !== 3) return invalid();
    const [headerBytes, payloadBytes, signature] = segments.map(decode) as [Buffer, Buffer, Buffer];
    if (headerBytes.length + payloadBytes.length + signature.length > this.limits.maxDecodedBytes)
      throw new ProtocolError("too-large");
    const header = parseObject(headerBytes, this.limits.maxJsonDepth);
    const claims = parseObject(payloadBytes, this.limits.maxJsonDepth);
    if (
      header.alg !== "ES256" ||
      header.typ !== "cw-evidence+jwt" ||
      Object.keys(header).some((k) => !["alg", "kid", "typ"].includes(k))
    )
      invalid();
    const trust = this.#trusts.get(nonempty(claims.iss));
    const key = trust?.keys.get(nonempty(header.kid));
    if (!trust || !key || signature.length !== 64) return invalid();
    try {
      if (
        !verify(
          "sha256",
          Buffer.from(`${segments[0]}.${segments[1]}`),
          { key, dsaEncoding: "ieee-p1363" },
          signature,
        )
      )
        invalid();
    } catch {
      return invalid();
    }
    common(claims, trust.maxLifetimeSeconds, trust.clockSkewSeconds, now);
    const audiences = typeof claims.aud === "string" ? [claims.aud] : (claims.aud as string[]);
    if (
      !audiences.includes(this.audience) ||
      !authenticatedSubject ||
      claims.sub !== authenticatedSubject ||
      !trust.domains.has(nonempty(object(claims[CLAIM]).domain))
    )
      return invalid();
    return new CheckedEvidence(claims, trust.clockSkewSeconds);
  }
}

export interface CommittedEvidenceInput {
  readonly subject: string;
  readonly audiences: readonly string[];
  readonly domain: string;
  readonly position: bigint;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly evidenceId?: string;
}

/** The storage adapter must commit the stable source/recovery fact before calling issueCommitted. */
export class Issuer {
  readonly #domains: Set<string>;
  readonly #limits: Readonly<Limits>;
  readonly #issuer: string;
  readonly #kid: string;
  readonly #key: KeyObject;
  readonly #maxLifetimeSeconds: bigint;
  constructor(
    issuer: string,
    kid: string,
    key: KeyObject,
    domains: ReadonlySet<string>,
    maxLifetimeSeconds: bigint,
    limits: Limits = DEFAULT_LIMITS,
  ) {
    validateLimits(limits);
    if (
      !httpsIssuer(issuer) ||
      !kid ||
      !p256Key(key, "private") ||
      !domains.size ||
      [...domains].some((d) => !absoluteUri(d)) ||
      typeof maxLifetimeSeconds !== "bigint" ||
      maxLifetimeSeconds <= 0n ||
      maxLifetimeSeconds > MAX_POSITION
    )
      throw new ProtocolError("invalid-configuration");
    this.#issuer = issuer;
    this.#kid = kid;
    this.#key = key;
    this.#maxLifetimeSeconds = maxLifetimeSeconds;
    this.#domains = new Set(domains);
    this.#limits = Object.freeze({ ...limits });
    Object.freeze(this);
  }

  issueCommitted(input: CommittedEvidenceInput, now: bigint): string {
    if (
      typeof input.position !== "bigint" ||
      input.position < 0n ||
      input.position > MAX_POSITION ||
      typeof input.issuedAt !== "bigint" ||
      input.issuedAt < 0n ||
      input.issuedAt > MAX_DATE ||
      typeof input.expiresAt !== "bigint" ||
      input.expiresAt > MAX_DATE ||
      input.expiresAt <= input.issuedAt ||
      typeof now !== "bigint" ||
      now < 0n ||
      input.issuedAt > now ||
      input.expiresAt <= now ||
      input.expiresAt - input.issuedAt > this.#maxLifetimeSeconds ||
      !this.#domains.has(input.domain) ||
      typeof input.subject !== "string" ||
      !input.subject ||
      !input.audiences.length ||
      input.audiences.some((a) => typeof a !== "string" || !a) ||
      new Set(input.audiences).size !== input.audiences.length ||
      (input.evidenceId !== undefined &&
        (typeof input.evidenceId !== "string" || !input.evidenceId))
    )
      return invalid();
    const claims = {
      iss: this.#issuer,
      sub: input.subject,
      aud: [...input.audiences],
      iat: Number(input.issuedAt),
      exp: Number(input.expiresAt),
      jti: input.evidenceId ?? `urn:uuid:${randomUUID()}`,
      [CLAIM]: {
        v: 1,
        profile: PROFILE,
        domain: input.domain,
        position: input.position.toString(),
        commit: "stable",
      },
    };
    const header = Buffer.from(
      JSON.stringify({ alg: "ES256", kid: this.#kid, typ: "cw-evidence+jwt" }),
    );
    const payload = Buffer.from(JSON.stringify(claims));
    if (header.length + payload.length + 64 > this.#limits.maxDecodedBytes)
      throw new ProtocolError("too-large");
    const message = `${header.toString("base64url")}.${payload.toString("base64url")}`;
    const token = `${message}.${sign("sha256", Buffer.from(message), { key: this.#key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    if (token.length > this.#limits.maxTokenBytes) throw new ProtocolError("too-large");
    return token;
  }
}
