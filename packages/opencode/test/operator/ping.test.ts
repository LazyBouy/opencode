import { beforeEach, expect, test } from "bun:test"
import path from "path"
import { Effect, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { OperatorAgentSessions } from "@/operator/agent-sessions"
import { OperatorLayout } from "@/operator/layout"
import { OperatorPingDefaults } from "@/operator/messaging/defaults"
import { OperatorMessageLog } from "@/operator/messaging/log"
import { OperatorProjectInbox } from "@/operator/messaging/inbox"
import { OperatorPing } from "@/operator/messaging/ping"
import { OperatorMessagingSettings } from "@/operator/messaging/settings"
import { OperatorPermissionLive } from "@/operator/permission-live"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { OperatorProjectRecords } from "@/operator/project-records"
import { OperatorProjects } from "@/operator/projects"
import { OperatorQueue } from "@/operator/queue"
import { OperatorQueueStore } from "@/operator/queue-store"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, send, session } from "../merge/harness"

// The `ping` tool within a project (SPEC-0023 §7, §14): offered only where a line allows it, discover filtered by
// the lines, send to agents, sessions and groups through the lanes, members enforced, wait and replyTo, the rate
// limits, and what the recipient reads.

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

type Body = { tools?: Array<{ function: { name: string; description?: string } }> }
const toolsOf = (body: unknown) => ((body as Body).tools ?? []).map((tool) => tool.function.name)

// The namespace's default lines, written in the project's config.
const defaults = { permission: { ping: OperatorPingDefaults.NAMESPACE } }

const setup = Effect.fn("test.ping.setup")(function* (extra: Record<string, unknown> = defaults) {
  const configured = yield* configure(extra)
  OperatorQueueStore.use(OperatorQueueStore.sqlite(path.join(configured.directory, ".queue.sqlite")))
  const ctx = yield* InstanceState.context
  const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
  const ping = yield* OperatorPing.Service
  const sender = yield* session()
  const asked: Array<{ patterns: string[]; always: string[] }> = []
  const cards: OperatorPing.Card[] = []
  const call = (
    args: OperatorPing.Args,
    options: { sessionID?: string; agent?: string; abort?: AbortSignal } = {},
  ): OperatorPing.Call => ({
    sessionID: options.sessionID ?? sender.id,
    agent: options.agent ?? "build",
    args,
    ask: async (input) => void asked.push({ patterns: input.patterns, always: input.always }),
    abort: options.abort ?? new AbortController().signal,
    progress: (_title, card) => void cards.push(card),
  })
  const record = (patch: OperatorProjectRecords.Patch) =>
    Effect.promise(async () => {
      const updated = await OperatorProjectRecords.update(project, patch)
      if (updated instanceof OperatorProjectRecords.InvalidError) throw new Error(updated.message)
      return updated
    })
  return { ...configured, project, ping, sender, asked, cards, call, record }
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

unix("ping is offered only where a ping line allows it: never in OpenCode's namespace by default", () =>
  Effect.gen(function* () {
    const plain = yield* configure()
    yield* plain.llm.text("ok")
    yield* send((yield* session()).id, "hello", "build")
    expect(toolsOf((yield* plain.llm.inputs)[0])).not.toContain("ping")
  }),
)

unix("with the default lines a model's ping send reaches the agent, headed with who sent it", () =>
  Effect.gen(function* () {
    const { llm, sender, project } = yield* setup()
    const sessions = yield* Session.Service
    yield* llm.tool("ping", { verb: "send", target: { type: "agent", id: "plan" }, message: { body: "hello plan" } })
    yield* llm.text("sent")
    yield* send(sender.id, "message plan", "build")

    const body = (yield* llm.inputs)[0]!
    expect(toolsOf(body)).toContain("ping")
    const described = (body as Body).tools!.find((tool) => tool.function.name === "ping")!.function.description
    expect(described).toContain("replyTo")

    // The call's part carries its card.
    const messages = yield* sessions.messages({ sessionID: sender.id })
    const part = messages
      .flatMap((message) => message.parts)
      .find((item) => item.type === "tool" && item.tool === "ping") as
      | { state: { status: string; metadata?: { ping?: OperatorPing.Card } } }
      | undefined
    expect(part?.state.status).toBe("completed")
    const card = part!.state.metadata!.ping!
    expect(card).toMatchObject({ verb: "send", target: "agent plan", status: "sent" })
    const id = card.messages![0]!.id!

    // plan's main session reads it with a header and the marker (marked delivered first, then written).
    const delivered = yield* settled(id, "delivered")
    const firstText = () =>
      sessions.messages({ sessionID: delivered.deliveredTo as never }).pipe(
        Effect.map(
          (all) =>
            all
              .filter((message) => message.info.role === "user")
              .flatMap((message) => message.parts)
              .find((item) => item.type === "text") as { text: string; metadata?: Record<string, any> } | undefined,
        ),
      )
    for (let attempt = 0; attempt < 250 && !(yield* firstText()); attempt++) yield* Effect.sleep("20 millis")
    const read = (yield* firstText())!
    expect(read.text).toBe(
      `Message from build (project ${path.basename(project)}, session ${sender.id}) · correlation ${id} · id ${id}:\nhello plan`,
    )
    expect(read.metadata?.message).toMatchObject({ id, from: { kind: "agent", agent: "build", session: sender.id } })
    expect(OperatorMessageLog.log().get(id)).toMatchObject({
      from: { kind: "agent", agent: "build" },
      to: { type: "agent", id: "plan" },
      status: "delivered",
    })
  }),
)

unix("discover lists what the lines let the agent message, and a denied target is refused", () =>
  Effect.gen(function* () {
    const { ping, call, record, asked } = yield* setup({
      permission: {
        ping: {
          ...OperatorPingDefaults.NAMESPACE,
          "DISCOVER(group/secret)": "deny",
          "SEND(agent/plan)": "deny",
          "DISCOVER(group/review)": "ask",
        },
      },
    })
    yield* record({
      groups: [
        { id: "g1", name: "review", members: ["plan"] },
        { id: "g2", name: "secret", members: ["plan"] },
      ],
    })
    const found = yield* ping.run(call({ verb: "discover" }))
    expect(found.output).toContain("- build (you)")
    expect(found.output).not.toContain("- plan")
    expect(found.output).toContain("- review: plan")
    expect(found.output).not.toContain("secret")
    expect(asked).toEqual([{ patterns: ["DISCOVER(group/review)"], always: ["DISCOVER(group/review)"] }])

    const refused = yield* ping.run(
      call({ verb: "send", target: { type: "agent", id: "plan" }, message: { body: "hi" } }),
    )
    expect(refused.card).toMatchObject({ status: "refused", reason: "the ping permission denies SEND(agent/plan)" })
    expect(asked).toHaveLength(1)
  }),
)

unix("send to a session and to a group (one message each, one correlation); members are enforced", () =>
  Effect.gen(function* () {
    const { ping, call, record, sender, asked } = yield* setup()
    // Paused: messages wait in the queue, so no turn starts.
    yield* record({ status: "paused", groups: [{ id: "g1", name: "team", members: ["build", "plan", "nobody"] }] })

    // An agent may message its own other sessions (one that has run as it).
    const other = yield* session()
    yield* send(other.id, "hi", "build")
    const toSession = yield* ping.run(
      call({ verb: "send", target: { type: "session", id: other.id }, message: { body: "note to self" } }),
    )
    expect(toSession.card.messages).toMatchObject([{ status: "queued" }])
    expect(OperatorQueueStore.store().get(toSession.card.messages![0]!.id!)).toMatchObject({
      target: "session",
      sessionID: other.id,
      agent: "build",
    })
    expect(asked.at(-1)).toEqual({ patterns: ["SEND(agent/build)"], always: ["SEND(agent/*)"] })

    // A group: every member but the sender; one that isn't an agent is refused, the others go.
    const team = yield* ping.run(
      call({ verb: "send", target: { type: "group", id: "team" }, message: { body: "standup" }, correlationID: "c_9" }),
    )
    expect(asked.at(-1)).toEqual({ patterns: ["SEND(group/team)"], always: ["SEND(group/*)"] })
    expect(team.card.messages!.map((item) => [item.to, item.status])).toEqual([
      ["plan", "queued"],
      ["nobody", "refused"],
    ])
    const logged = OperatorMessageLog.log().list({ correlationID: "c_9" })
    expect(logged.map((item) => [item.agent, item.to])).toEqual([["plan", { type: "group", id: "team" }]])

    // Members: a recipient that isn't one is refused; so is a sender that isn't one.
    yield* record({ members: ["build"], groups: [] })
    const outsider = yield* ping.run(
      call({ verb: "send", target: { type: "agent", id: "plan" }, message: { body: "hi" } }),
    )
    expect(outsider.card).toMatchObject({ status: "refused" })
    expect(outsider.output).toContain("plan is not a member")
    yield* record({ members: ["plan"] })
    const notMember = yield* ping.run(
      call({ verb: "send", target: { type: "agent", id: "plan" }, message: { body: "hi" } }),
    )
    expect(notMember.card).toMatchObject({ status: "refused", reason: "build is not a member of this project" })
    expect(sender.id).toBeTruthy()
  }),
)

unix("wait gets the reply sent with replyTo, times out, ends on abort, and is refused on its own session", () =>
  Effect.gen(function* () {
    const { ping, call, cards, sender } = yield* setup()

    const waiting = yield* ping
      .run(
        call({
          verb: "send",
          target: { type: "agent", id: "plan" },
          message: { body: "review section 2" },
          wait: true,
          timeout: 30,
        }),
      )
      .pipe(Effect.forkChild)
    for (let attempt = 0; attempt < 250 && !cards.some((card) => card.status === "waiting"); attempt++)
      yield* Effect.sleep("20 millis")
    const card = cards.find((item) => item.status === "waiting")!
    expect(card.wait).toMatchObject({ timeout: 30, from: "plan" })
    const id = card.messages![0]!.id!
    const delivered = yield* settled(id, "delivered")

    // plan answers from its session: the reply goes to the waiting call at once.
    const answered = yield* ping.run(
      call(
        { verb: "send", replyTo: id, message: { body: "looks good" } },
        { sessionID: delivered.deliveredTo!, agent: "plan" },
      ),
    )
    expect(answered.card.messages).toMatchObject([{ status: "delivered" }])
    const result = yield* Fiber.join(waiting)
    expect(result.card).toMatchObject({ status: "replied", reply: { from: "plan", text: "looks good" } })
    expect(result.output).toContain("looks good")
    const reply = OperatorMessageLog.log().get(answered.card.messages![0]!.id!)!
    expect(reply).toMatchObject({ correlationID: id, replyTo: id, sessionID: sender.id, status: "delivered" })
    expect(reply.trail.map((step) => step.detail)).toEqual(["handed to the waiting ping"])

    // A reply only from the message's recipient, to a message from an agent.
    const stranger = yield* ping.run(call({ verb: "send", replyTo: id, message: { body: "me too" } }))
    expect(stranger.card).toMatchObject({ status: "refused", reason: `${id} was not sent to you` })

    // No reply: the timeout.
    const quiet = yield* ping.run(
      call({
        verb: "send",
        target: { type: "agent", id: "plan" },
        message: { body: "anyone?" },
        wait: true,
        timeout: 1,
      }),
    )
    expect(quiet.card).toMatchObject({ status: "no reply" })
    expect(quiet.output).toContain("No reply within 1 s.")

    // The session's abort ends the wait.
    const abort = new AbortController()
    const stopped = yield* ping
      .run(
        call(
          { verb: "send", target: { type: "agent", id: "plan" }, message: { body: "hello?" }, wait: true },
          { abort: abort.signal },
        ),
      )
      .pipe(Effect.forkChild)
    yield* Effect.sleep("100 millis")
    abort.abort()
    expect(String((yield* Fiber.await(stopped))._tag)).toBe("Failure")

    // Waiting on its own session could never be answered.
    const own = yield* ping.run(
      call({ verb: "send", target: { type: "session", id: sender.id }, message: { body: "me" }, wait: true }),
    )
    expect(own.card).toMatchObject({ status: "refused", reason: "waiting on your own session; it could never answer" })

    // The conversation: the message and its reply, oldest first, and the sessions they went between.
    const talk = yield* (yield* OperatorProjectInbox.Service).conversation(id)
    expect(talk.messages.map((item) => item.id)).toEqual([id, answered.card.messages![0]!.id!])
    expect(talk.sessions.map((item) => item.id).toSorted()).toEqual([sender.id, delivered.deliveredTo!].toSorted())
    expect(talk.sessions.find((item) => item.id === delivered.deliveredTo)).toMatchObject({
      agent: "plan",
      title: "plan · main session",
      exists: true,
    })
  }),
)

unix("discover names each agent's sessions; session: new gives the conversation a session of its own", () =>
  Effect.gen(function* () {
    const { ping, call } = yield* setup()
    const sessions = yield* Session.Service
    const main = (yield* (yield* OperatorAgentSessions.Service).ensureMain("plan")).session
    const found = yield* ping.run(call({ verb: "discover" }))
    expect(found.output).toContain(`· main ${main.id} "plan · main session"`)

    const sent = yield* ping.run(
      call({
        verb: "send",
        target: { type: "agent", id: "plan", session: "new" },
        message: { body: "Draft the release notes\nfor 2.0" },
      }),
    )
    expect(sent.card.messages).toMatchObject([{ to: "plan (a new session)", status: "queued" }])
    const delivered = yield* settled(sent.card.messages![0]!.id!, "delivered")
    expect(delivered.target).toBe("new")
    expect(delivered.deliveredTo).not.toBe(main.id)
    const made = yield* sessions.get(delivered.deliveredTo as never)
    expect(made).toMatchObject({ title: "plan · Draft the release notes", agent: "plan" })
  }),
)

unix("the rate limits: 30 sends a minute per agent, a group counting as one", () =>
  Effect.gen(function* () {
    const { ping, call, record } = yield* setup()
    yield* record({ status: "paused", groups: [{ id: "g1", name: "team", members: ["plan", "general"] }] })
    for (let count = 0; count < OperatorMessagingSettings.DEFAULTS.perMinute - 1; count++) {
      const sent = yield* ping.run(
        call({ verb: "send", target: { type: "agent", id: "plan" }, message: { body: "n" } }),
      )
      expect(sent.card.status).toBe("sent")
    }
    const group = yield* ping.run(call({ verb: "send", target: { type: "group", id: "team" }, message: { body: "g" } }))
    expect(group.card.messages).toHaveLength(2)
    const over = yield* ping.run(call({ verb: "send", target: { type: "agent", id: "plan" }, message: { body: "n" } }))
    expect(over.card).toMatchObject({ status: "refused", reason: "the rate limit: at most 30 sends a minute" })
  }),
)

test("the default lines are written once into the namespaces there are; never in OpenCode's tests", async () => {
  const settings = await OperatorLayout.readSettings()
  try {
    await OperatorLayout.writeSettings({ ...settings, pingDefaults: undefined })
    expect(await OperatorPingDefaults.ensure({ OPENCODE_TEST_HOME: "x" })).toBe(false)
    expect(await OperatorPingDefaults.ensure({ OPENCODE_PING_DEFAULTS: "on" })).toBe(true)
    expect((await OperatorLayout.readSettings()).pingDefaults).toBe(true)
    expect(await OperatorPingDefaults.ensure({ OPENCODE_PING_DEFAULTS: "on" })).toBe(false)
  } finally {
    await OperatorLayout.writeSettings(settings)
  }
})
