import path from "path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { OperatorHelperAgents } from "@/operator/helper-agents"
import { OperatorHelperRuns } from "@/operator/helper-runs"
import { OperatorHelpers } from "@/operator/helpers"
import { OperatorOverview } from "@/operator/overview"
import { OperatorPermissionEffective } from "@/operator/permission-effective"
import { OperatorPermissionLive } from "@/operator/permission-live"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { OperatorProfileStore } from "@/operator/profile-store"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, send, session } from "../merge/harness"

// Helper runs (agent_types_spec.md §4.5–4.7, §6): an agent calls a callable helper of its namespace with the
// `helper` tool and gets its output; a helper with actions runs in a hidden child session, may do only what it
// declares, never asks, and its run is recorded.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorProfileStore.node,
      OperatorHelpers.node,
      OperatorHelperRuns.node,
      OperatorPermissionLive.node,
      OperatorPermissionLocks.node,
      OperatorOverview.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

// The global config folder (where namespaces/ lives) inside the test project, for one test.
const withGlobal = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = { config: Global.Path.config, roots: process.env.OPENCODE_WORKSPACE_ROOTS }
        ;(Global.Path as { config: string }).config = dir
        process.env.OPENCODE_WORKSPACE_ROOTS = path.dirname(dir)
        return previous
      }),
      () => body,
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous.config
          if (previous.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
          else process.env.OPENCODE_WORKSPACE_ROOTS = previous.roots
        }),
    )
  })

const toolParts = (messages: ReadonlyArray<{ parts: ReadonlyArray<unknown> }>, tool: string) =>
  messages.flatMap((message) =>
    message.parts.filter(
      (
        part,
      ): part is {
        type: "tool"
        tool: string
        state: { status: string; output?: string; error?: string; metadata?: Record<string, unknown> }
      } => (part as { type?: string; tool?: string }).type === "tool" && (part as { tool?: string }).tool === tool,
    ),
  )

unix("a callable helper is offered to its namespace's agents; a call returns its output and is recorded", () =>
  withGlobal(
    Effect.gen(function* () {
      const { llm } = yield* configure()
      const helpers = yield* OperatorHelpers.Service
      const runs = yield* OperatorHelperRuns.Service
      const effective = OperatorPermissionEffective.handlers.effective!

      // Not offered while the namespace has no callable helper (OpenCode's tool list stays upstream's), even when
      // another namespace has one.
      const store = yield* OperatorProfileStore.Service
      const acme = yield* store.createNamespace({
        name: "Acme",
        folder: path.join((yield* TestInstance).directory, "namespaces", "acme"),
      })
      yield* helpers.create(acme.id, { name: "elsewhere", model: { source: "default" }, text: "x", callable: true })
      expect((yield* effective({ agent: "build" })).offered ?? []).not.toContain("helper")
      yield* helpers.create("opencode", {
        name: "sorter",
        model: { source: "default" },
        text: "Say what kind of issue this is: bug, feature or question.",
        callable: true,
        usage: "an issue → bug, feature or question",
      })
      expect((yield* effective({ agent: "build" })).offered ?? []).toContain("helper")

      yield* llm.tool("helper", { name: "sorter", input: "The app crashes on start." })
      yield* llm.text("bug")
      yield* llm.text("It is a bug.")
      const parent = yield* session()
      yield* send(parent.id, "What kind of issue is this?", "build")

      const sessions = yield* Session.Service
      const [call] = toolParts(yield* sessions.messages({ sessionID: parent.id }), "helper")
      expect(call?.state.status).toBe("completed")
      expect(call?.state.output).toBe("bug")
      // The helper's text was its system prompt.
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs[1])).toContain("Say what kind of issue this is")

      const [run] = yield* runs.runs("opencode", "sorter")
      expect(run).toMatchObject({
        status: "done",
        output: "bug",
        input: "The app crashes on start.",
        startedBy: { kind: "agent", agent: "build", sessionID: parent.id },
      })
      // Without actions it is one model call: no session of its own.
      expect(run?.sessionID).toBeUndefined()
    }),
  ),
)

unix("a helper with `read` only can't run bash, never asks, and runs in a hidden child session", () =>
  withGlobal(
    Effect.gen(function* () {
      const { llm } = yield* configure()
      const helpers = yield* OperatorHelpers.Service
      const runs = yield* OperatorHelperRuns.Service
      yield* helpers.create("opencode", {
        name: "reader",
        model: { source: "default" },
        text: "Read what you are asked about and report it.",
        callable: true,
        actions: ["read"],
      })

      yield* llm.tool("helper", { name: "reader", input: "Look at the readme." })
      yield* llm.tool("bash", { command: "echo hi", description: "Say hi" })
      yield* llm.text("I may only read.")
      yield* llm.text("done")
      const parent = yield* session()
      yield* send(parent.id, "Ask the reader.", "build")

      const [run] = yield* runs.runs("opencode", "reader")
      expect(run?.status).toBe("done")
      expect(run?.output).toBe("I may only read.")
      const sessions = yield* Session.Service
      const child = yield* sessions.get(SessionID.make(run!.sessionID!))
      expect(child.parentID).toBe(parent.id)
      expect(child.agent).toBe(OperatorHelperAgents.agentName("opencode", "reader"))
      expect(child.metadata?.operator).toMatchObject({ kind: "helper-run", helper: "reader" })

      // bash never ran: it isn't offered, and its permission is denied.
      const [bash] = toolParts(yield* sessions.messages({ sessionID: child.id }), "bash")
      expect(bash?.state.status).not.toBe("completed")
      const lines = yield* OperatorPermissionEffective.handlers.effective!({ sessionID: child.id, agent: child.agent! })
      const decide = (permission: string, pattern: string) =>
        Permission.evaluate(permission, pattern, [...(lines.rules as PermissionV1.Ruleset)]).action
      expect(decide("bash", "echo hi")).toBe("deny")
      expect(decide("read", "/project/README.md")).toBe("allow")
      expect(decide("memory", "WRITE(agent/notes.md)")).toBe("deny")
      // Nothing asks: no line of a run is an ask, and no request waits.
      expect(lines.lines?.some((line) => line.action === "ask")).toBe(false)
      expect(yield* (yield* Permission.Service).list()).toEqual([])

      // Hidden: not in the operator's session lists.
      const listed = yield* (yield* OperatorOverview.Service).sessions({})
      expect(listed.some((item) => item.id === child.id)).toBe(false)
      expect(listed.some((item) => item.id === parent.id)).toBe(true)
    }),
  ),
)
