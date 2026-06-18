import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt from node:crypto — no native/external dependency
 * (keeps the image lean and avoids musl/glibc binary headaches). The stored
 * form is `<saltHex>:<hashHex>`; verification is constant-time.
 */
const KEY_LEN = 64;
const SALT_LEN = 16;

export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(plain, salt, KEY_LEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  const actual = scryptSync(plain, Buffer.from(saltHex, "hex"), KEY_LEN);
  return timingSafeEqual(expected, actual);
}
