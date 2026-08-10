import { describe, expect, it } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  resolveFlowSourceConversations,
  resolveFreshFlowSourceConversations,
} from "./flow-sources";

const alice = "conversation-alice" as Id<"conversations">;
const bob = "conversation-bob" as Id<"conversations">;
const conversations = [
  { conversationId: alice, contributorName: "Alice Smith" },
  { conversationId: bob, contributorName: "Bob Jones" },
];

describe("resolveFlowSourceConversations", () => {
  it("resolves the existing Flow V3 citation formats by creation order", () => {
    expect(
      resolveFlowSourceConversations(
        ["Alice Smith, Conv. 1", "Conversation 2 — Bob Jones"],
        conversations,
      ),
    ).toEqual([
      {
        source: "Alice Smith, Conv. 1",
        conversationId: alice,
        contributorName: "Alice Smith",
      },
      {
        source: "Conversation 2 — Bob Jones",
        conversationId: bob,
        contributorName: "Bob Jones",
      },
    ]);
  });

  it("rejects unknown positions and contributor mismatches", () => {
    expect(
      resolveFlowSourceConversations(
        ["Mallory, Conv. 1", "Alice Smith, Conv. 9", "Alice Smith"],
        conversations,
      ),
    ).toEqual([]);
  });

  it("deduplicates repeated references to the same conversation", () => {
    expect(
      resolveFlowSourceConversations(
        ["Alice Smith, Conv. 1", "Alice Smith — Conversation 1"],
        conversations,
      ),
    ).toHaveLength(1);
  });

  it("links only while the Flow evidence positions remain current", () => {
    const current = conversations.map((conversation, index) => ({
      ...conversation,
      creationTime: index + 1,
      status: "done",
    }));

    expect(
      resolveFreshFlowSourceConversations(
        ["Alice Smith, Conv. 1"],
        { stale: false, conversationCount: 2 },
        current,
      ),
    ).toHaveLength(1);
    expect(
      resolveFreshFlowSourceConversations(
        ["Alice Smith, Conv. 1"],
        { stale: true, conversationCount: 2 },
        current,
      ),
    ).toEqual([]);
    expect(
      resolveFreshFlowSourceConversations(
        ["Alice Smith, Conv. 1"],
        { stale: false, conversationCount: 1 },
        current,
      ),
    ).toEqual([]);
  });
});
