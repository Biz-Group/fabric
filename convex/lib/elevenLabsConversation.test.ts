import { describe, expect, test } from "vitest";
import {
  assertElevenLabsConversationIdentity,
  buildElevenLabsConversationUrl,
  isElevenLabsConversationId,
  requireElevenLabsConversationId,
} from "./elevenLabsConversation";

describe("ElevenLabs conversation IDs", () => {
  test.each([
    "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw",
    "21m00Tcm4TlvDq8ikWAM",
    "seed-conv-001",
    "a".repeat(128),
  ])("accepts a canonical opaque identifier: %s", (conversationId) => {
    expect(isElevenLabsConversationId(conversationId)).toBe(true);
    expect(requireElevenLabsConversationId(conversationId)).toBe(
      conversationId,
    );
  });

  test.each([
    "",
    "a".repeat(129),
    "../../user#",
    "..",
    "conversation/id",
    "conversation\\id",
    "conversation?id=other",
    "conversation#fragment",
    "%2e%2e%2fuser",
    "conversation id",
    "conversation.123",
    "会話",
  ])("rejects a non-canonical identifier: %s", (conversationId) => {
    expect(isElevenLabsConversationId(conversationId)).toBe(false);
    expect(() => requireElevenLabsConversationId(conversationId)).toThrow(
      "Invalid ElevenLabs conversation identifier",
    );
  });
});

describe("buildElevenLabsConversationUrl", () => {
  test("builds only the conversation details endpoint", () => {
    expect(
      buildElevenLabsConversationUrl(
        "conv_7401k5m9x2p8ec3rqv6dtnhb0fzw",
      ).href,
    ).toBe(
      "https://api.elevenlabs.io/v1/convai/conversations/conv_7401k5m9x2p8ec3rqv6dtnhb0fzw",
    );
  });

  test("builds only the conversation audio endpoint", () => {
    expect(buildElevenLabsConversationUrl("seed-conv-001", "audio").href).toBe(
      "https://api.elevenlabs.io/v1/convai/conversations/seed-conv-001/audio",
    );
  });

  test("rejects traversal before URL construction can normalize it", () => {
    expect(() =>
      buildElevenLabsConversationUrl("../../user#", "audio"),
    ).toThrow("Invalid ElevenLabs conversation identifier");
  });
});

describe("assertElevenLabsConversationIdentity", () => {
  test("accepts the requested conversation from the configured agent", () => {
    expect(() =>
      assertElevenLabsConversationIdentity(
        { conversation_id: "conv_123", agent_id: "agent_456" },
        "conv_123",
        "agent_456",
      ),
    ).not.toThrow();
  });

  test("rejects a response for a different conversation", () => {
    expect(() =>
      assertElevenLabsConversationIdentity(
        { conversation_id: "conv_other", agent_id: "agent_456" },
        "conv_123",
        "agent_456",
      ),
    ).toThrow("ElevenLabs conversation identifier mismatch");
  });

  test("rejects a response from a different configured agent", () => {
    expect(() =>
      assertElevenLabsConversationIdentity(
        { conversation_id: "conv_123", agent_id: "agent_other" },
        "conv_123",
        "agent_456",
      ),
    ).toThrow("ElevenLabs agent identifier mismatch");
  });
});
