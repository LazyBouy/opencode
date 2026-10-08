import path from "path"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OperatorPermissionLive } from "@/operator/permission-live"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, send } from "../merge/harness"

// The effective list R (tool_prompt_from_permission.md §3.3, §4): what every ask checks last, and what
// the request's tool list, the skills list and the Tool Prompt use. A tool is offered only if some call
// to it could be allowed or asked.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorToolPrompt.node,
      OperatorPermissionLive.node,
      OperatorSessionPermissions.node,
      OperatorPermissionLocks.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

type Body = { tools?: Array<{ function: { name: string } }> }
const toolsOf = (body: unknown) => ((body as Body).tools ?? []).map((tool) => tool.function.name)
const names = (prompt: OperatorToolPrompt.ToolPrompt) => prompt.list.map((item) => item.name)

// Asks, and says whether the ask was allowed without a reply (a waiting ask is answered once).
const allowed = (input: {
  sessionID: Session.Info["id"]
  id: string
  permission: string
  pattern: string
  ruleset: PermissionV1.Ruleset
}) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const asked = yield* permission
      .ask({
        id: PermissionV1.ID.make(input.id),
        sessionID: input.sessionID,
        permission: input.permission,
        patterns: [input.pattern],
        metadata: {},
        always: [input.pattern],
        ruleset: input.ruleset,
      })
      .pipe(Effect.forkScoped)
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((yield* permission.list()).some((item) => item.id === input.id)) {
        yield* permission.reply({ requestID: PermissionV1.ID.make(input.id), reply: "once" })
        yield* Fiber.join(asked)
        return false
      }
      if (asked.pollUnsafe()) break
      yield* Effect.sleep("10 millis")
    }
    yield* Fiber.join(asked)
    return true
  })

unix("a tool no call could be allowed for is not offered, though its last rule is not `*`", () =>
  Effect.gen(function* () {
    const { llm } = yield* configure({
      agent: {
        noshell: { mode: "primary", permission: { bash: { "*": "deny", "rm *": "deny" } } },
        gitonly: { mode: "primary", permission: { bash: { "*": "deny", "git *": "allow" } } },
      },
    })
    const sessions = yield* Session.Service
    const prompts = yield* OperatorToolPrompt.Service
    yield* llm.text("ok")
    yield* llm.text("ok")

    yield* send((yield* sessions.create({ title: "No shell", agent: "noshell" })).id, "hello", "noshell")
    expect(toolsOf((yield* llm.inputs).at(-1))).not.toContain("bash")
    const noshell = yield* prompts.build({ agent: "noshell" })
    expect(names(noshell)).toEqual(toolsOf((yield* llm.inputs).at(-1)))
    const bash = noshell.notSent.find((item) => item.name === "bash")!
    expect(bash.reason).toBe("permission")
    expect(noshell.rows.find((row) => row.index === bash.rule)).toMatchObject({ pattern: "rm *", action: "deny" })

    // `git *` can be allowed: bash stays.
    yield* send((yield* sessions.create({ title: "Git", agent: "gitonly" })).id, "hello", "gitonly")
    expect(toolsOf((yield* llm.inputs).at(-1))).toContain("bash")
    expect(names(yield* prompts.build({ agent: "gitonly" }))).toContain("bash")
  }),
)

unix("a locked deny removes the tool even after the session's allow; the Tool Prompt names the lock", () =>
  Effect.gen(function* () {
    const { llm } = yield* configure({
      agent: { fetchless: { mode: "primary", permission: { webfetch: "deny" } } },
    })
    const sessions = yield* Session.Service
    const prompts = yield* OperatorToolPrompt.Service
    const locks = yield* OperatorPermissionLocks.Service
    const sessionPermissions = yield* OperatorSessionPermissions.Service
    yield* llm.text("ok")
    yield* llm.text("ok")

    const s = yield* sessions.create({ title: "Fetch", agent: "fetchless" })
    yield* sessionPermissions.save(s.id, [{ permission: "webfetch", pattern: "*", action: "allow" }])
    yield* send(s.id, "hello", "fetchless")
    expect(toolsOf((yield* llm.inputs).at(-1))).toContain("webfetch")

    yield* locks.save("fetchless", { locks: [{ permission: "webfetch", pattern: "*" }], inherit: "own" })
    yield* send(s.id, "again", "fetchless")
    expect(toolsOf((yield* llm.inputs).at(-1))).not.toContain("webfetch")
    const prompt = yield* prompts.build({ agent: "fetchless", sessionID: s.id })
    expect(names(prompt)).toEqual(toolsOf((yield* llm.inputs).at(-1)))
    const webfetch = prompt.notSent.find((item) => item.name === "webfetch")!
    expect(prompt.rows.find((row) => row.index === webfetch.rule)).toMatchObject({
      permission: "webfetch",
      action: "deny",
      from: { kind: "lock" },
    })
  }),
)

unix("an agent's rules saved since its project loaded apply to the tool list at once", () =>
  Effect.gen(function* () {
    const { directory, llm } = yield* configure()
    const sessions = yield* Session.Service
    const prompts = yield* OperatorToolPrompt.Service
    const live = yield* OperatorPermissionLive.Service
    yield* llm.text("ok")

    yield* live.written({
      directory,
      agent: "build",
      rules: [{ permission: "webfetch", pattern: "*", action: "deny" }],
    })
    yield* send((yield* sessions.create({ title: "Build" })).id, "hello", "build")
    expect(toolsOf((yield* llm.inputs).at(-1))).not.toContain("webfetch")
    const prompt = yield* prompts.build({ agent: "build" })
    const webfetch = prompt.notSent.find((item) => item.name === "webfetch")!
    expect(prompt.rows.find((row) => row.index === webfetch.rule)?.from).toEqual({ kind: "agent-written" })
    // A draft stands in for the agent's own rules, the saved ones included.
    expect(names(yield* prompts.build({ agent: "build", agentRules: [] }))).toContain("webfetch")
  }),
)

unix("a session's skill deny hides the skills list, which upstream builds from the agent alone", () =>
  Effect.gen(function* () {
    const { directory, llm } = yield* configure()
    const fs = yield* FSUtil.Service
    const sessions = yield* Session.Service
    const sessionPermissions = yield* OperatorSessionPermissions.Service
    yield* fs.writeWithDirs(
      path.join(directory, ".opencode", "skills", "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greets every visitor warmly.\n---\nSay hello.\n",
    )
    yield* llm.text("ok")
    yield* llm.text("ok")

    yield* send((yield* sessions.create({ title: "Skills" })).id, "hello", "build")
    expect(JSON.stringify((yield* llm.inputs).at(-1))).toContain("Greets every visitor warmly.")

    const denied = yield* sessions.create({ title: "No skills" })
    yield* sessionPermissions.save(denied.id, [{ permission: "skill", pattern: "*", action: "deny" }])
    yield* send(denied.id, "hello", "build")
    const body = (yield* llm.inputs).at(-1)
    expect(JSON.stringify(body)).not.toContain("Greets every visitor warmly.")
    expect(toolsOf(body)).not.toContain("skill")
  }),
)

unix("R decides an ask given the agent's rules; an ask given a narrower list keeps it", () =>
  Effect.gen(function* () {
    yield* configure({
      agent: { careful: { mode: "primary", description: "Careful", permission: { bash: { "*": "ask" } } } },
    })
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const sessionPermissions = yield* OperatorSessionPermissions.Service
    const loaded = (yield* agents.get("careful"))!.permission
    const allowAll: PermissionV1.Rule = { permission: "bash", pattern: "*", action: "allow" }
    const s = yield* sessions.create({ title: "Careful", agent: "careful" })

    // A turn read the session's `bash *` allow when it started; the rule is removed while it runs.
    yield* sessionPermissions.save(s.id, [allowAll])
    const turnStart = Permission.merge(loaded, [allowAll])
    expect(
      yield* allowed({ sessionID: s.id, id: "per_r1", permission: "bash", pattern: "ls", ruleset: turnStart }),
    ).toBe(true)
    yield* sessionPermissions.save(s.id, [])
    // R (the agent's ask, no session rule) decides, not the list the turn started with.
    expect(
      yield* allowed({ sessionID: s.id, id: "per_r2", permission: "bash", pattern: "ls", ruleset: turnStart }),
    ).toBe(false)

    // The workflow tool approval asks with no rules: OpenCode's `* allow` doesn't answer it.
    expect(
      yield* allowed({
        sessionID: s.id,
        id: "per_r3",
        permission: "workflow_tool_approval",
        pattern: "x",
        ruleset: [],
      }),
    ).toBe(false)
    // /merge asks with the deny rules only: what they don't deny asks, and a session rule still applies.
    const denies = loaded.filter((rule) => rule.action === "deny")
    expect(
      yield* allowed({ sessionID: s.id, id: "per_r4", permission: "edit", pattern: "a.ts", ruleset: denies }),
    ).toBe(false)
    yield* sessionPermissions.save(s.id, [{ permission: "edit", pattern: "*", action: "allow" }])
    expect(
      yield* allowed({ sessionID: s.id, id: "per_r5", permission: "edit", pattern: "a.ts", ruleset: denies }),
    ).toBe(true)
  }),
)

unix("Runs as Subagent, started from a session: the Tool Prompt gets that session's rules, as `task` passes them", () =>
  Effect.gen(function* () {
    const { llm } = yield* configure()
    const sessions = yield* Session.Service
    const prompts = yield* OperatorToolPrompt.Service
    const sessionPermissions = yield* OperatorSessionPermissions.Service
    const parent = yield* sessions.create({ title: "Parent" })
    yield* sessionPermissions.save(parent.id, [{ permission: "webfetch", pattern: "*", action: "deny" }])
    yield* llm.tool("task", { description: "Look around", prompt: "Find the readme", subagent_type: "explore" })
    yield* llm.text("Found it.")
    yield* llm.text("Done.")
    yield* send(parent.id, "explore please", "build")
    const sub = (yield* llm.inputs).find((body) => JSON.stringify(body).includes("file search specialist"))
    expect(toolsOf(sub)).not.toContain("webfetch")

    const started = yield* prompts.build({ agent: "explore", runsAs: "subagent", parentSessionID: parent.id })
    expect(started.parentSessionID).toBe(parent.id)
    expect(names(started)).toEqual(toolsOf(sub))
    expect(started.notSent.find((item) => item.name === "webfetch")?.reason).toBe("subagent")
    // From a new session: nothing passes, and explore keeps webfetch.
    expect(names(yield* prompts.build({ agent: "explore", runsAs: "subagent" }))).toContain("webfetch")
  }),
)
