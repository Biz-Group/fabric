const ELEVENLABS_API_ORIGIN = "https://api.elevenlabs.io";
const ELEVENLABS_CONVERSATION_PATH = "/v1/convai/conversations/";
const ELEVENLABS_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

type ElevenLabsConversationResource = "conversation" | "audio";

/**
 * ElevenLabs conversation IDs are opaque identifiers, not URL paths. Keep the
 * accepted alphabet deliberately narrow so traversal, query, fragment, and
 * encoded-path payloads can never be interpreted by URL normalization.
 */
export function requireElevenLabsConversationId(value: string): string {
  if (!ELEVENLABS_CONVERSATION_ID.test(value)) {
    throw new Error("Invalid ElevenLabs conversation identifier");
  }
  return value;
}

export function isElevenLabsConversationId(value: string): boolean {
  return ELEVENLABS_CONVERSATION_ID.test(value);
}

export function buildElevenLabsConversationUrl(
  conversationId: string,
  resource: ElevenLabsConversationResource = "conversation",
): URL {
  const canonicalId = requireElevenLabsConversationId(conversationId);
  const suffix = resource === "audio" ? "/audio" : "";
  return new URL(
    `${ELEVENLABS_CONVERSATION_PATH}${encodeURIComponent(canonicalId)}${suffix}`,
    ELEVENLABS_API_ORIGIN,
  );
}

/**
 * Bind an upstream response to the exact resource that was requested. When a
 * server-side agent ID is configured, also prevent importing conversations
 * from another agent that happens to be accessible with the same API key.
 */
export function assertElevenLabsConversationIdentity(
  payload: unknown,
  expectedConversationId: string,
  expectedAgentId?: string,
): void {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid response from ElevenLabs");
  }

  const conversation = payload as {
    conversation_id?: unknown;
    agent_id?: unknown;
  };
  if (conversation.conversation_id !== expectedConversationId) {
    throw new Error("ElevenLabs conversation identifier mismatch");
  }
  if (expectedAgentId && conversation.agent_id !== expectedAgentId) {
    throw new Error("ElevenLabs agent identifier mismatch");
  }
}
