import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, session } from "../merge/harness"

const it = testEffect(
  LayerNode.compile(LayerNode.group([root, OperatorSessionPermissions.node, OperatorToolPrompt.node]), replacements),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const rule = (permission: string, pattern: string, action: "allow" | "ask" | "deny") => ({
  permission,
  pattern,
  action,
})

unix("a session with no rules of its own is like its agent; its own rules come after the agent's and win", () =>
  Effect.gen(function* () {
    yield* configure()
    const permissions = yield* OperatorSessionPermissions.Service
    const prompts = yield* OperatorToolPrompt.Service
    const first = yield* session()
    const second = yield* session()

    const plain = yield* permissions.get(first.id)
    expect(plain.agent).toBe("build")
    expect(plain.written).toEqual([])
    expect(plain.editable).toEqual({ start: plain.rows.length, end: plain.rows.length })

    // A session rule that denies webfetch: that session no longer sends webfetch; the other still does.
    const saved = yield* permissions.save(first.id, [rule("webfetch", "*", "deny")])
    expect(saved.written).toEqual([rule("webfetch", "*", "deny")])
    expect(saved.rows.at(-1)).toMatchObject({ permission: "webfetch", part: "session", from: { kind: "session-user" } })
    expect((saved.rows.at(-1)!.from as { time?: number }).time).toBeGreaterThan(0)
    expect((yield* (yield* Session.Service).get(first.id)).permission).toEqual([rule("webfetch", "*", "deny")])

    const denied = yield* prompts.build({ agent: "build", sessionID: first.id })
    expect(denied.runsAs).toBe("session")
    expect(denied.sent.map((item) => item.name)).not.toContain("webfetch")
    expect(denied.notSent).toContainEqual(expect.objectContaining({ name: "webfetch", reason: "session" }))
    const other = yield* prompts.build({ agent: "build", sessionID: second.id })
    expect(other.sent.map((item) => item.name)).toContain("webfetch")

    // Reset to agent: no rules, and no record.
    const reset = yield* permissions.save(first.id, [])
    expect(reset.written).toEqual([])
    expect(yield* Effect.promise(() => OperatorSessionPermissions.recorded(first.id))).toEqual([])
  }),
)

unix("rules keep where they came from: Always allow stays Always allow after a save that keeps it", () =>
  Effect.gen(function* () {
    yield* configure()
    const permissions = yield* OperatorSessionPermissions.Service
    const sessions = yield* Session.Service
    const current = yield* session()
    // As the reply hook does: the rule is added to the session, with its origin.
    yield* sessions.setPermission({ sessionID: current.id, permission: [rule("bash", "git *", "allow")] })
    yield* Effect.promise(() =>
      OperatorSessionPermissions.record(current.id, [rule("bash", "git *", "allow")], "always", 1000),
    )

    const info = yield* permissions.save(current.id, [rule("bash", "git *", "allow"), rule("read", "*.secret", "deny")])
    const rows = info.rows.slice(info.editable.start)
    expect(rows.map((row) => row.from)).toEqual([
      { kind: "session-always", time: 1000 },
      expect.objectContaining({ kind: "session-user" }),
    ])
  }),
)

unix("a subagent session's rules from task are labelled as added by task", () =>
  Effect.gen(function* () {
    yield* configure()
    const permissions = yield* OperatorSessionPermissions.Service
    const sessions = yield* Session.Service
    const parent = yield* session()
    const child = yield* sessions.create({
      parentID: parent.id,
      title: "Subagent",
      permission: [rule("todowrite", "*", "deny"), rule("task", "*", "deny")],
    })
    const info = yield* permissions.get(child.id)
    expect(info.parent).toBe(true)
    expect(info.rows.slice(info.editable.start).map((row) => row.from.kind)).toEqual(["session-task", "session-task"])
  }),
)
