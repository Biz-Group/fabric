import type { Id } from "../../../convex/_generated/dataModel";

export type FlowSourceConversation = {
  source: string;
  conversationId: Id<"conversations">;
  contributorName: string;
};

type ConversationSourceCandidate = {
  conversationId: Id<"conversations">;
  contributorName: string;
};

type FlowSourceState = {
  stale: boolean;
  conversationCount: number;
};

export type FlowConversationForSources = ConversationSourceCandidate & {
  creationTime: number;
  status: string;
};

const MAX_CONVERSATIONS_PER_FLOW = 50;

const CONVERSATION_NUMBER = /\bconv(?:ersation)?\.?\s*#?\s*(\d+)\b/i;

function normalizedCitation(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Resolves the citation format already emitted by Flow V3 ("Name, Conv. N")
 * without changing its prompt or persisted node schema. Callers must only pass
 * the exact, fresh creation-ordered conversation set used by the flow.
 */
export function resolveFlowSourceConversations(
  sources: readonly string[],
  conversations: readonly ConversationSourceCandidate[],
): FlowSourceConversation[] {
  const resolved = new Map<Id<"conversations">, FlowSourceConversation>();

  for (const rawSource of sources) {
    const source = rawSource.trim();
    const match = source.match(CONVERSATION_NUMBER);
    if (!match) continue;

    const position = Number(match[1]);
    if (!Number.isSafeInteger(position) || position < 1) continue;
    const conversation = conversations[position - 1];
    if (!conversation) continue;

    const citation = normalizedCitation(source);
    const contributor = normalizedCitation(conversation.contributorName);
    if (!contributor || !citation.includes(contributor)) continue;

    if (!resolved.has(conversation.conversationId)) {
      resolved.set(conversation.conversationId, {
        source,
        conversationId: conversation.conversationId,
        contributorName: conversation.contributorName,
      });
    }
  }

  return Array.from(resolved.values());
}

/**
 * Resolves links only when the current conversation set still matches the
 * evidence positions used by Flow V3. Otherwise the citation remains text.
 */
export function resolveFreshFlowSourceConversations(
  sources: readonly string[],
  flow: FlowSourceState,
  conversations: readonly FlowConversationForSources[],
): FlowSourceConversation[] {
  if (flow.stale) return [];
  const done = conversations
    .filter((conversation) => conversation.status === "done")
    .sort((a, b) => a.creationTime - b.creationTime);
  if (
    done.length > MAX_CONVERSATIONS_PER_FLOW ||
    done.length !== flow.conversationCount
  ) {
    return [];
  }
  return resolveFlowSourceConversations(sources, done);
}
