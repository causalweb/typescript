import { sign, verify } from "node:crypto";

const DELIVERY_TYPE = "causalweb-reference-delivery+jwt";

export function deliveryProof(event, kid, key) {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid, typ: DELIVERY_TYPE })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(event)).toString("base64url");
  const message = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" });
  return `${message}.${signature.toString("base64url")}`;
}

export function validDeliveryProof(event, proof, kid, key) {
  if (typeof proof !== "string") return false;
  const parts = proof.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  const [header, payload, signature] = parts;
  try {
    const protectedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    if (
      protectedHeader.alg !== "ES256" ||
      protectedHeader.kid !== kid ||
      protectedHeader.typ !== DELIVERY_TYPE ||
      payload !== Buffer.from(JSON.stringify(event)).toString("base64url")
    )
      return false;
    return verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export async function sendDelivery(event, destination, token, kid, key, signal) {
  const result = await fetch(new URL("/deliver", destination), {
    method: "POST",
    redirect: "manual",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ event, proof: deliveryProof(event, kid, key) }),
  });
  await result.body?.cancel();
  return result.status;
}
