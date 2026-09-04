import { describe, expect, test } from "vitest";
import {
  AUDIO_PLAYBACK_TOKEN_TTL_MS,
  signAudioPlaybackToken,
  verifyAudioPlaybackToken,
  type AudioPlaybackTokenClaims,
} from "./audioPlaybackToken";

const SECRET = "test-audio-signing-secret-with-sufficient-entropy";
const CLAIMS: AudioPlaybackTokenClaims = {
  clerkOrgId: "org_alpha",
  conversationId: "conversation_123",
  membershipId: "membership_456",
  expiresAt: 1_800_000_000_000,
};

describe("audio playback tokens", () => {
  test("use a five-minute lifetime", () => {
    expect(AUDIO_PLAYBACK_TOKEN_TTL_MS).toBe(5 * 60 * 1000);
  });

  test("verify when every signed claim matches", async () => {
    const signature = await signAudioPlaybackToken(SECRET, CLAIMS);

    await expect(
      verifyAudioPlaybackToken(SECRET, CLAIMS, signature),
    ).resolves.toBe(true);
  });

  test.each([
    ["organization", { clerkOrgId: "org_other" }],
    ["conversation", { conversationId: "conversation_other" }],
    ["membership", { membershipId: "membership_other" }],
    ["expiration", { expiresAt: CLAIMS.expiresAt + 1 }],
  ])("rejects a changed %s claim", async (_name, replacement) => {
    const signature = await signAudioPlaybackToken(SECRET, CLAIMS);

    await expect(
      verifyAudioPlaybackToken(
        SECRET,
        { ...CLAIMS, ...replacement },
        signature,
      ),
    ).resolves.toBe(false);
  });

  test("rejects malformed signatures before cryptographic verification", async () => {
    await expect(
      verifyAudioPlaybackToken(SECRET, CLAIMS, "not-a-signature"),
    ).resolves.toBe(false);
  });
});
