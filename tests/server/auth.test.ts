import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode, bearerToken, isUsableSecret, signToken, verifyToken } from "../../server/auth";
import { NOW, SECRET } from "./helpers";

describe("bearer tokens", () => {
  it("signs and verifies a token", async () => {
    const token = await signToken("USER1", NOW + 60_000, SECRET);
    expect(token.split(".")).toHaveLength(2);
    expect(await verifyToken(token, SECRET, NOW)).toEqual({ sub: "USER1", exp: NOW + 60_000, v: 1 });
  });

  it("rejects expired tokens", async () => {
    const token = await signToken("USER1", NOW, SECRET);
    expect(await verifyToken(token, SECRET, NOW)).toBeNull();
    expect(await verifyToken(token, SECRET, NOW - 1)).not.toBeNull();
  });

  it("rejects tampered payloads, signatures and other secrets", async () => {
    const token = await signToken("USER1", NOW + 60_000, SECRET);
    const [body, sig] = token.split(".");
    const forgedBody = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ sub: "ADMIN", exp: NOW + 60_000, v: 1 })));
    expect(await verifyToken(`${forgedBody}.${sig}`, SECRET, NOW)).toBeNull();
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect(await verifyToken(`${body}.${flipped}`, SECRET, NOW)).toBeNull();
    expect(await verifyToken(token, SECRET + "x", NOW)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    for (const bad of ["", "abc", "a.b.c", ".", "a.", ".b", "!!!.???", "x".repeat(2000)]) {
      expect(await verifyToken(bad, SECRET, NOW)).toBeNull();
    }
    // Correctly signed but wrong version / shape.
    const { subtle } = crypto;
    const key = await subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ sub: "U", exp: NOW + 1000, v: 2 })));
    const sig = base64UrlEncode(new Uint8Array(await subtle.sign("HMAC", key, new TextEncoder().encode(body))));
    expect(await verifyToken(`${body}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it("base64url round-trips and rejects junk", () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 128, 1]);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    expect(base64UrlDecode("a+b/")).toBeNull();
    expect(base64UrlDecode("a")).toBeNull();
  });

  it("requires a long enough secret and parses Bearer headers", () => {
    expect(isUsableSecret(undefined)).toBe(false);
    expect(isUsableSecret("short")).toBe(false);
    expect(isUsableSecret(SECRET)).toBe(true);
    const req = (h?: string) => new Request("https://x/api/v1/me", { headers: h ? { authorization: h } : {} });
    expect(bearerToken(req("Bearer abc.def"))).toBe("abc.def");
    expect(bearerToken(req("Basic abc"))).toBeNull();
    expect(bearerToken(req())).toBeNull();
  });
});
