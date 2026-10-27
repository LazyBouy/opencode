import { describe, expect, test } from "bun:test"
import {
  draftOf,
  hasReplies,
  matchParts,
  move,
  newRuleId,
  recipientText,
  ruleOf,
  senderOf,
  tabOf,
} from "./project-inbox-model"

describe("the Project inbox page's parts", () => {
  test("tabs, senders and recipients", () => {
    expect(tabOf("dead")).toBe("dead")
    expect(tabOf("nonsense")).toBe("messages")
    expect(tabOf(undefined)).toBe("messages")
    expect(senderOf({ kind: "agent", agent: "writer", project: "p1" }, "p1")).toMatchObject({
      kind: "agent",
      agent: "writer",
    })
    expect(senderOf({ kind: "agent", agent: "writer", project: "p2" }, "p1")).toMatchObject({
      kind: "otherProject",
      project: "p2",
    })
    expect(senderOf({ kind: "user" }, "p1").kind).toBe("user")
    expect(recipientText({ type: "inbox" })).toBeUndefined()
    expect(recipientText({ type: "project-agent", project: "p2", id: "writer" })).toBe("agent writer")
    expect(recipientText({ type: "group", id: "review" })).toBe("group review")
  })

  test("reordering, ids, and whether replies still find their sender", () => {
    expect(move(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"])
    expect(move(["a", "b"], 0, 5)).toEqual(["a", "b"])
    const replies = ruleOf({ ...draftOf(), name: "Replies", reply: true, action: "to-sender" }, "replies", "replies")
    expect(hasReplies([replies])).toBe(true)
    expect(hasReplies([{ ...replies, enabled: false }])).toBe(false)
    expect(newRuleId([{ ...replies, id: "r2" }])).toBe("r3")
  })

  test("a rule through the form and back keeps its parts; empty fields are left out", () => {
    const rule = {
      id: "ops",
      name: "Ops",
      enabled: true,
      match: {
        fromProject: ["p2", "p3"],
        fromAgent: ["writer"],
        fromSession: ["ses_a", "ses_b"],
        recipient: { type: "group" as const, id: "review" },
        priority: "high" as const,
        contains: "deploy",
        pattern: "^v\\d",
      },
      action: {
        kind: "forward" as const,
        to: [{ type: "agent" as const, id: "build" }],
        steer: true,
        priority: "urgent" as const,
      },
    }
    expect(ruleOf(draftOf(rule), "ops")).toEqual(rule)
    expect(draftOf(rule).fromSessions).toBe("ses_a, ses_b")
    expect(matchParts(rule.match).find((part) => part.key === "fromSessions")?.value).toBe("ses_a, ses_b")
    const blank = ruleOf({ ...draftOf(), name: " Plain ", action: "manager" }, "r1")
    expect(blank).toEqual({ id: "r1", name: "Plain", enabled: true, match: {}, action: { kind: "manager" } })
    expect(
      ruleOf(
        { ...draftOf(), name: "x", fromProject: "this", recipient: "none", recipientId: "ignored", action: "drop" },
        "r2",
      ).match,
    ).toEqual({
      fromProject: "this",
      recipient: { type: "none" },
    })
    expect(matchParts(rule.match).map((part) => part.key)).toEqual([
      "fromProjects",
      "fromAgents",
      "fromSessions",
      "recipient",
      "priority",
      "contains",
      "pattern",
    ])
  })
})
