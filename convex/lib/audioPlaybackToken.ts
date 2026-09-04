export const AUDIO_PLAYBACK_TOKEN_TTL_MS = 5 * 60 * 1000;

export type AudioPlaybackTokenClaims = {
  clerkOrgId: string;
  conversationId: string;
  membershipId: string;
  expiresAt: number;
};

function serializeClaims(claims: AudioPlaybackTokenClaims): string {
  return JSON.stringify([
    "audio-v2",
    claims.clerkOrgId,
    claims.conversationId,
    claims.membershipId,
    claims.expiresAt,
  ]);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function signatureBytes(value: string): ArrayBuffer | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < value.length; i += 2) {
    bytes[i / 2] = Number.parseInt(value.slice(i, i + 2), 16);
  }
  return bytes.buffer;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signAudioPlaybackToken(
  secret: string,
  claims: AudioPlaybackTokenClaims,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importSigningKey(secret),
    new TextEncoder().encode(serializeClaims(claims)),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyAudioPlaybackToken(
  secret: string,
  claims: AudioPlaybackTokenClaims,
  providedSignature: string,
): Promise<boolean> {
  const signature = signatureBytes(providedSignature);
  if (!signature) return false;
  return await crypto.subtle.verify(
    "HMAC",
    await importSigningKey(secret),
    signature,
    new TextEncoder().encode(serializeClaims(claims)),
  );
}
