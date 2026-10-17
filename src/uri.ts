import { isIP } from "node:net";

// RFC 3986 identifier validation without WHATWG URL repair or normalization.
const unreserved = "A-Za-z0-9._~\\-";
const subdelims = "!$&'()*+,;=";
const component = (extra: string) =>
  new RegExp(`^(?:[${unreserved}${subdelims}${extra}]|%[A-Fa-f0-9]{2})*$`);
const pathChars = component(":@/");
const queryChars = component(":@/?");
const regName = component("");
const userInfo = component(":");

export function absoluteUri(value: string): boolean {
  if (typeof value !== "string" || /[^\x21-\x7E]/.test(value)) return false;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(value)?.[0];
  if (!scheme) return false;
  let rest = value.slice(scheme.length);
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    if (!queryChars.test(rest.slice(hash + 1))) return false;
    rest = rest.slice(0, hash);
  }
  const question = rest.indexOf("?");
  if (question !== -1) {
    if (!queryChars.test(rest.slice(question + 1))) return false;
    rest = rest.slice(0, question);
  }
  if (rest.startsWith("//")) {
    const slash = rest.indexOf("/", 2);
    let authority = slash === -1 ? rest.slice(2) : rest.slice(2, slash);
    rest = slash === -1 ? "" : rest.slice(slash);
    const at = authority.lastIndexOf("@");
    if (at !== -1) {
      if (!userInfo.test(authority.slice(0, at))) return false;
      authority = authority.slice(at + 1);
    }
    if (authority.startsWith("[")) {
      const close = authority.indexOf("]");
      if (close === -1) return false;
      const ip = authority.slice(1, close);
      if (
        isIP(ip) !== 6 &&
        !new RegExp(`^[vV][0-9A-Fa-f]+\\.[${unreserved}${subdelims}:]+$`).test(ip)
      )
        return false;
      if (!/^(?::[0-9]*)?$/.test(authority.slice(close + 1))) return false;
    } else {
      const colon = authority.indexOf(":");
      if (colon !== -1) {
        if (!/^[0-9]*$/.test(authority.slice(colon + 1))) return false;
        authority = authority.slice(0, colon);
      }
      if (!regName.test(authority)) return false;
    }
  }
  return pathChars.test(rest);
}

export function httpsIssuer(value: string): boolean {
  if (!/^https:\/\//i.test(value) || !absoluteUri(value)) return false;
  const authority = value.slice(8).split(/[/?#]/, 1)[0]!;
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return host.length > 0 && !host.startsWith(":");
}
