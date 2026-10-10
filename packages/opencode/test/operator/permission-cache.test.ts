import { expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus } from "@/bus/global"
import { OperatorConfig } from "@/operator/config"
import { OperatorFileCache } from "@/operator/file-cache"
import { OperatorPermissionLive } from "@/operator/permission-live"
import { OperatorPermissionMarks } from "@/operator/permission-marks"
import { OperatorPermissionDecide } from "@/operator/permission-decide"
import { OperatorPermissionDecisions } from "@/operator/permission-decisions"
import { OperatorPermissionEffective } from "@/operator/permission-effective"
import { OperatorPermissionHook } from "@/operator/permission-hook"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { Agent } from "@/agent/agent"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { configure, replacements, root } from "../merge/harness"

// The effective permission set is built for every ask and every model request (permission-live.ts). How
// long that takes, cold and warm: the numbers are printed for the commit and the report.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorPermissionDecide.node,
      OperatorPermissionDecisions.node,
      OperatorSessionPermissions.node,
      OperatorPermissionLocks.node,
      OperatorPermissionLive.node,
      OperatorConfig.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

const agents = {
  reviewer: {
    mode: "primary",
    description: "Reviews",
    prompt: "Review.",
    permission: { bash: { "*": "allow", "git push*": "ask" }, read: { "*.secret": "deny" } },
  },
}

const ROUNDS = 10
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>, times: number) =>
  Effect.gen(function* () {
    const start = performance.now()
    const first = yield* effect
    const cold = performance.now() - start
    const warmStart = performance.now()
    for (let index = 1; index < times; index++) yield* effect
    return { first, cold, warm: (performance.now() - warmStart) / (times - 1) }
  })

unix("the effective permission set: how long an ask and a model request take to build it", () =>
  Effect.gen(function* () {
    yield* configure({ agent: agents })
    const sessions = yield* Session.Service
    const agent = yield* (yield* Agent.Service).get("reviewer")
    const s = yield* sessions.create({ title: "Review", agent: "reviewer" })
    const ask = timed(
      OperatorPermissionHook.handlers.rules!({
        sessionID: s.id,
        permission: "bash",
        patterns: ["git status"],
        given: agent.permission,
      }),
      ROUNDS,
    )
    const request = timed(
      OperatorPermissionEffective.handlers.effective!({ agent: "reviewer", sessionID: s.id }),
      ROUNDS,
    )
    const hook = yield* ask
    const tools = yield* request
    expect(hook.first.at(-1)).toMatchObject({ permission: "bash", pattern: "git status", action: "allow" })
    expect(tools.first?.lines?.length ?? 0).toBeGreaterThan(0)
    console.log(
      `permission set: ask cold ${hook.cold.toFixed(2)} ms, warm ${hook.warm.toFixed(2)} ms; ` +
        `model request cold ${tools.cold.toFixed(2)} ms, warm ${tools.warm.toFixed(2)} ms`,
    )
  }),
)

// The kept levels (permission-live.ts) must never be stale: every change applies on the very next ask.
const writeJson = (file: string, value: unknown) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(value, null, 2))
  })
const readJson = (file: string) =>
  Effect.promise(() =>
    fs
      .readFile(file, "utf8")
      .then((text) => JSON.parse(text) as Record<string, unknown>)
      .catch(() => ({}) as Record<string, unknown>),
  )
// Files outside the test's project, put back as they were.
const restoring = <A, E, R>(files: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => Promise.all(files.map((file) => fs.readFile(file, "utf8").catch(() => undefined)))),
    () => effect,
    (before) =>
      Effect.promise(() =>
        Promise.all(
          files.map((file, index) =>
            before[index] === undefined ? fs.rm(file, { force: true }) : fs.writeFile(file, before[index]!),
          ),
        ),
      ),
  )

unix("every change applies on the very next ask, with the kept levels warm", () =>
  Effect.gen(function* () {
    yield* configure({ agent: agents })
    const { directory } = yield* TestInstance
    const sessions = yield* Session.Service
    const live = yield* OperatorPermissionLive.Service
    const locks = yield* OperatorPermissionLocks.Service
    const sessionPermissions = yield* OperatorSessionPermissions.Service
    const operatorConfig = yield* OperatorConfig.Service
    const s = yield* sessions.create({ title: "Review", agent: "reviewer" })
    const action = (input: string) => live.decide(s.id, "bash", input).pipe(Effect.map((decision) => decision.action))
    const globalConfig = path.join(Global.Path.config, "opencode.json")
    const store = path.join(Global.Path.config, "namespaces")
    const settings = path.join(store, "settings.json")
    const opencode = path.join(store, "opencode", "namespace.json")
    yield* restoring(
      [globalConfig, settings, opencode, OperatorPermissionMarks.projectFile(), OperatorPermissionLocks.file()],
      Effect.gen(function* () {
        expect(yield* action("make all")).toBe("allow")
        expect(yield* action("make all")).toBe("allow")

        // Nothing changed: a warm ask reads no file.
        const reads = OperatorFileCache.counts.reads
        for (let index = 0; index < 10; index++) yield* action("make all")
        expect(OperatorFileCache.counts.reads).toBe(reads)

        // A hand edit of the project's config file.
        const project = path.join(directory, "opencode.json")
        yield* writeJson(project, { ...(yield* readJson(project)), permission: { bash: { "make *": "deny" } } })
        expect(yield* action("make all")).toBe("deny")

        // A config file that appears (the project's .opencode/opencode.jsonc, read after opencode.json).
        yield* writeJson(path.join(directory, ".opencode", "opencode.jsonc"), {
          permission: { bash: { "make *": "ask" } },
        })
        expect(yield* action("make all")).toBe("ask")

        // OperatorConfig's writes (the project's own file: the .opencode one, the first that exists).
        yield* operatorConfig.update("project", { permission: { bash: { "make *": "allow" } } })
        expect(yield* action("make all")).toBe("allow")

        // Global's config.
        yield* writeJson(globalConfig, { permission: { bash: { "npm *": "deny" } } })
        expect(yield* action("npm i")).toBe("deny")

        // The namespace store: with a working directory, OpenCode leaves out Global's capabilities.
        yield* writeJson(settings, { workingDir: path.join(directory, "work") })
        yield* writeJson(opencode, {
          ...(yield* readJson(opencode)),
          id: "opencode",
          name: "OpenCode",
          inheritGlobal: false,
        })
        expect(yield* action("npm i")).toBe("allow")
        yield* writeJson(opencode, { ...(yield* readJson(opencode)), inheritGlobal: true })
        expect(yield* action("npm i")).toBe("deny")

        // The project's marks: locking its line sets the session's own line aside.
        yield* sessionPermissions.save(s.id, [{ permission: "bash", pattern: "make *", action: "deny" }])
        expect(yield* action("make all")).toBe("deny")
        yield* Effect.promise(() =>
          OperatorPermissionMarks.writeProject(directory, {
            locks: [{ permission: "bash", pattern: "make *" }],
            deleted: [],
          }),
        )
        expect(yield* action("make all")).toBe("allow")

        // The agent's locks.
        yield* sessionPermissions.save(s.id, [{ permission: "bash", pattern: "ls", action: "deny" }])
        expect(yield* action("ls")).toBe("deny")
        yield* locks.save("reviewer", { locks: [{ permission: "bash", pattern: "*" }], inherit: "own" })
        expect(yield* action("ls")).toBe("allow")

        // The agent's rules just written (Allow for agent, the Permissions editor), before a reload.
        yield* live.written({
          directory,
          agent: "reviewer",
          rules: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "cat *", action: "deny" },
          ],
        })
        expect(yield* action("cat a")).toBe("deny")

        // The instance reloads: what OpenCode loaded again (the written rules were read, or dropped).
        GlobalBus.emit("event", { directory, payload: { type: "server.instance.disposed", properties: { directory } } })
        expect(yield* action("cat a")).toBe("allow")
      }),
    )
  }),
)
