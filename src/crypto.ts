const encoder = new TextEncoder();

export function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await hmacKey(secret, "sign");
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** タイミング攻撃に強い比較 (crypto.subtle.verify) で HMAC を検証する */
export async function hmacVerify(
  secret: string,
  message: BufferSource | string,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await hmacKey(secret, "verify");
  const data = typeof message === "string" ? encoder.encode(message) : message;
  return crypto.subtle.verify("HMAC", key, signature, data);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 不正な base64 の場合は例外を投げる */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return base64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}
