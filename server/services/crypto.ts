import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../_core/env";

/**
 * Encryption for mailbox OAuth tokens at rest.
 *
 * A refresh token is a durable credential: whoever holds it can read and send as
 * the connected mailbox until the user revokes it. It must never be written to the
 * database in plaintext, and it must never be invented when the key is missing —
 * so every function here fails closed. If `MAIL_CREDENTIAL_KEY` is not configured,
 * `mailCryptoConfigured()` is false, the mailbox connect flow refuses to run, and
 * outreach falls back to the global SMTP path rather than silently storing a token
 * anyone with read access to the DB could lift.
 *
 * AES-256-GCM is used rather than CBC because it authenticates: a tampered cipher
 * throws on decrypt instead of handing back corrupted bytes that would later be
 * sent to Google/Microsoft as if they were a valid token.
 */

const PREFIX = "v1";
const IV_BYTES = 12; // 96-bit nonce, the size GCM wants
const KEY_BYTES = 32; // AES-256

function keyBytes(): Buffer {
  const raw = env.mailCredentialKey;
  if (!raw) throw new Error("MAIL_CREDENTIAL_KEY is not configured");
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`MAIL_CREDENTIAL_KEY must be ${KEY_BYTES} random bytes, base64-encoded`);
  }
  return key;
}

/** True when the credential key is present and well-formed, so secrets can be stored. */
export function mailCryptoConfigured(): boolean {
  if (!env.mailCredentialKey) return false;
  try {
    return keyBytes().length === KEY_BYTES;
  } catch {
    return false;
  }
}

/** Encrypt a secret into `v1:<iv>:<tag>:<data>` (all base64). Throws without a key. */
export function encryptSecret(plaintext: string): string {
  const key = keyBytes();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

/**
 * Decrypt a value produced by {@link encryptSecret}. Returns null (rather than
 * throwing) for an empty/absent cipher, so callers can treat "nothing stored" and
 * "undecryptable" as distinct from a hard auth failure — a tampered or wrong-key
 * payload throws, because that is a security event, not an absence.
 */
export function decryptSecret(cipherText: string | null | undefined): string | null {
  if (!cipherText) return null;
  const parts = cipherText.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("Malformed credential cipher");
  }
  const key = keyBytes();
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return dec.toString("utf8");
}
