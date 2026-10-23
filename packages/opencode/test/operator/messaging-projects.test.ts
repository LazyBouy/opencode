import { beforeEach, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Fiber, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorAgentSessions } from "@/operator/agent-sessions"
import { OperatorPingDefaults } from "@/operator/messaging/defaults"
import { OperatorProjectInbox } from "@/operator/messaging/inbox"
import { OperatorMessageLog } from "@/operator/messaging/log"
import { OperatorPing } from "@/operator/messaging/ping"
import { OperatorPermissionLive } from "@/operator/permission-live"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { OperatorQueue } from "@/operator/queue"
import { OperatorQueueStore } from "@/operator/queue-store"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, session } from "../merge/harness"

// Between projects (SPEC-0023 §9): a message to another project's agent or group enters that project's inbox,
// whose rules or manager decide; only projects of the sender's namespace are reached; `*` is denied by default; a
// reply goes back through the sender's project's inbox, where "Replies go to their sender" hands it to the
// waiting ping; each inbox entered counts a hop.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorToolPrompt.node,
      OperatorPermissionLive.node,
      OperatorSessionPermissions.node,
      OperatorPermissionLocks.node,
      OperatorAgentSessions.node,
      OperatorQueue.node,
      OperatorProjectInbox.node,
      OperatorPing.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

beforeEach(() => OperatorPing.resetLimits())

const projectsFile = () => path.join(Global.Path.config, "namespaces", "projects.json")

// This test's folder is project web01 of namespace acme; app02 (a folder in it) is acme's too; ext03 is beta's.
const setup = Effect.fn("test.projects.setup")(function* (lines: Record<string, string> = {}) {
  const configured = yield* configure({ permission: { ping: { ...OperatorPingDefaults.NAMESPACE, ...lines } } })
  OperatorQueueStore.use(OperatorQueueStore.sqlite(path.join(configured.directory, ".queue.sqlite")))
  const web = configured.directory
  const app = path.join(web, "app")
  const ext = path.join(web, "ext")
  const before = yield* Effect.promise(() => fs.readFile(projectsFile(), "utf8").catch(() => undefined))
  yield* Effect.promise(async () => {
    await fs.mkdir(app, { recursive: true })
    await fs.mkdir(ext, { recursive: true })
    await fs.mkdir(path.dirname(projectsFile()), { recursive: true })
    const current = before ? (JSON.parse(before) as Record<string, unknown>) : {}
    await fs.writeFile(
      projectsFile(),
      JSON.stringify({
        ...current,
        [web]: { namespace: "acme", id: "web01" },
        [app]: { namespace: "acme", id: "app02" },
        [ext]: { namespace: "beta", id: "ext03" },
      }),
    )
  })
  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      before === undefined ? fs.rm(projectsFile(), { force: true }) : fs.writeFile(projectsFile(), before),
    ),
  )
  const ping = yield* OperatorPing.Service
  const instances = yield* InstanceStore.Service
  const sender = yield* session()
  const asked: string[][] = []
  const call = (args: OperatorPing.Args, options: { sessionID?: string; agent?: string } = {}): OperatorPing.Call => ({
    sessionID: options.sessionID ?? sender.id,
    agent: options.agent ?? "build",
    args,
    ask: async (input) => void asked.push(input.patterns),
    abort: new AbortController().signal,
    progress: () => undefined,
  })
  // A ping from a session of another project runs in that project's instance.
  const inProject = <A, E>(folder: string, effect: Effect.Effect<A, E>) =>
    instances.provide({ directory: folder }, effect)
  return { ...configured, web, app, ext, ping, sender, call, asked, inProject }
})

const settled = (id: string, status: OperatorQueueStore.Status) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 250; attempt++) {
      const item = OperatorQueueStore.store().get(id)
      if (item?.status === status) return item
      yield* Effect.sleep("20 millis")
    }
    throw new Error(`${id} is ${OperatorQueueStore.store().get(id)?.status}, not ${status}`)
  })

unix(
  "a message to another project's agent enters its inbox; the reply comes back through ours to the waiting ping",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ping, call, asked, sender, web, app, inProject } = yield* setup()
        const sessions = yield* Session.Service

        // discover lists the namespace's other projects, not another namespace's.
        const found = yield* ping.run(call({ verb: "discover" }))
        expect(found.output).toContain("- app (app02)")
        expect(found.output).not.toContain("ext03")

        // build (web01) asks app02's plan, and waits.
        const waiting = yield* ping
          .run(
            call({
              verb: "send",
              target: { type: "project.agent", id: "app02/plan" },
              message: { body: "Which API version do you ship?" },
              wait: true,
              timeout: 30,
            }),
          )
          .pipe(Effect.forkChild)
        for (let attempt = 0; attempt < 250 && !asked.length; attempt++) yield* Effect.sleep("20 millis")
        expect(asked[0]).toEqual(["SEND(project/app02/agent/plan)"])

        // In app02's inbox: as addressed (no rule, no manager), a copy for plan, from build of web01.
        let copy: OperatorQueueStore.Item | undefined
        for (let attempt = 0; attempt < 250 && !copy; attempt++) {
          copy = OperatorQueueStore.store()
            .list({ agent: "plan" })
            .find((item) => item.project === app)
          if (!copy) yield* Effect.sleep("20 millis")
        }
        expect(copy).toMatchObject({
          sender: { kind: "agent", agent: "build", sessionID: sender.id, project: "web01" },
        })
        const entered = OperatorMessageLog.log().get(copy!.via!.id)!
        expect(entered).toMatchObject({
          inbox: "app02",
          to: { type: "project-agent", project: "app02", id: "plan" },
          status: "routed",
          routedBy: "as addressed",
          hops: 1,
        })
        const delivered = yield* settled(copy!.id, "delivered")

        // plan reads who sent it, from which project and session.
        let read: string | undefined
        for (let attempt = 0; attempt < 250 && !read; attempt++) {
          read = (yield* sessions.messages({ sessionID: delivered.deliveredTo as never }))
            .filter((message) => message.info.role === "user")
            .flatMap((message) => message.parts)
            .flatMap((part) => (part.type === "text" ? [part.text] : []))[0]
          if (!read) yield* Effect.sleep("20 millis")
        }
        expect(read).toStartWith(`Message from build (project ${path.basename(web)}, session ${sender.id})`)

        // plan answers from app02: through web01's inbox ("Replies go to their sender") to build's waiting call.
        const answered = yield* inProject(
          app,
          ping.run(
            call(
              { verb: "send", replyTo: copy!.id, message: { body: "v3, since May" } },
              {
                sessionID: delivered.deliveredTo!,
                agent: "plan",
              },
            ),
          ),
        )
        expect(asked.at(-1)).toEqual(["SEND(project/web01/agent/build)"])
        expect(answered.card.messages).toMatchObject([{ status: "routed" }])
        const result = yield* Fiber.join(waiting)
        expect(result.card).toMatchObject({ status: "replied", reply: { from: "plan", text: "v3, since May" } })
        const reply = OperatorMessageLog.log().get(answered.card.messages![0]!.id!)!
        expect(reply).toMatchObject({ inbox: "web01", routedBy: "rule Replies go to their sender", hops: 2 })
      }),
    ),
)

unix("only this namespace's projects; not this project; every project (*) is denied by default", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { ping, call } = yield* setup()
      const send = (type: OperatorPing.Target["type"], id?: string) =>
        ping.run(call({ verb: "send", target: { type, ...(id ? { id } : {}) }, message: { body: "hi" } }))
      expect((yield* send("project.agent", "ext03/plan")).card.reason).toBe(
        "project ext03 is in another namespace; only this namespace's are reached",
      )
      expect((yield* send("project.agent", "web01/plan")).card.reason).toBe(
        "web01 is this project: send to {type: agent}",
      )
      expect((yield* send("project.agent", "nope9/plan")).card.reason).toBe("no project nope9")
      expect((yield* send("projects.groups", "app02")).card.reason).toBe("name it as <projectID>/<group> (target.id)")
      expect((yield* send("*")).card.reason).toBe("the ping permission denies SEND(*)")
    }),
  ),
)

unix("with SEND(*) allowed, * enters every other project's inbox of the namespace; a group's goes as addressed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { ping, call } = yield* setup({ "SEND(*)": "allow" })
      const everyone = yield* ping.run(
        call({ verb: "send", target: { type: "*" }, message: { body: "release on Friday" } }),
      )
      expect(everyone.card.messages).toMatchObject([{ to: "project app", status: "dead letter" }])
      expect(OperatorMessageLog.log().get(everyone.card.messages![0]!.id!)).toMatchObject({
        inbox: "app02",
        to: { type: "all-projects" },
      })
      // A group of another project: its inbox delivers to the group as addressed (no group there: a dead letter).
      const group = yield* ping.run(
        call({
          verb: "send",
          target: { type: "projects.groups", id: "app02/review" },
          message: { body: "please review" },
        }),
      )
      expect(group.card.messages).toMatchObject([{ to: "group review (project app)", status: "dead letter" }])
    }),
  ),
)
