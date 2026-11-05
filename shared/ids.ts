/**
 * Time-sortable unique ids (ULID-style: 10 chars of time + 16 chars of randomness,
 * Crockford base32). Lexicographic order == creation order (to the millisecond).
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function newId(now: number = Date.now()): string {
  let time = "";
  let t = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (const b of randomBytes(16)) rand += ALPHABET[b % 32];
  return time + rand;
}

/** Epoch ms encoded in an id from newId(), or NaN if it isn't one. */
export function idTime(id: string): number {
  if (!isId(id)) return NaN;
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}

export function isId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}
