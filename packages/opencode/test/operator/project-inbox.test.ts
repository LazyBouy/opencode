import { beforeEach, expect } from "bun:test"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { OperatorAgentSessions } from "@/operator/agent-sessions"
import { OperatorPingDefaults } from "@/operator/messaging/defaults"
import { OperatorProjectInbox } from "@/operator/messaging/inbox"
import { OperatorMessageLog } from "@/operator/messaging/log"
import { OperatorPing } from "@/operator/messaging/ping"
import { OperatorInboxRules } from "@/operator/messaging/rules"
import { OperatorPermissionLive } from "@/operator/permission-live"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { OperatorProjectRecords } from "@/operator/project-records"
import { OperatorProjects } from "@/operator/projects"
import { OperatorQueue } from "@/operator/queue"
import { OperatorQueueStore } from "@/operator/queue-store"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { OperatorTrash } from "@/operator/trash"
import { OperatorTrashFiles } from "@/operator/trash-files"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, send, session } from "../merge/harness"

// The Project inbox (SPEC-0023 §8, §14): the routing order (the first matching rule, then the manager, then as
// addressed, then dead letter or broadcast), both presets, the manager's verbs (only the manager's; RULE asks), the
// dead letter's actions, the hop limit, and every step in the trail.

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
      OperatorTrash.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

beforeEach(() => OperatorPing.resetLimits())

const setup = Effect.fn("test.inbox.setup")(function* () {
  const configured = yield* configure({ permission: { ping: OperatorPingDefaults.NAMESPACE } })
  OperatorQueueStore.use(OperatorQueueStore.sqlite(path.join(configured.directory, ".queue.sqlite")))
  const ctx = yield* InstanceState.context
  const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
  const id = yield* Effect.promise(() => OperatorProjectInbox.projectIdOf(project))
  const inbox = yield* OperatorProjectInbox.Service
  const ping = yield* OperatorPing.Service
  const record = (patch: OperatorProjectRecords.Patch) =>
    Effect.promise(async () => {
      const updated = await OperatorProjectRecords.update(project, patch)
      if (updated instanceof OperatorProjectRecords.InvalidError) throw new Error(updated.message)
      return updated
    })
  const enter = (text: string, extra: Partial<OperatorProjectInbox.Entry> = {}) =>
    inbox.enter({ project, from: { kind: "user" }, body: { type: "text", text }, ...extra })
  const asked: string[][] = []
  const call = (args: OperatorPing.Args, options: { sessionID: string; agent: string }): OperatorPing.Call => ({
    ...options,
    args,
    ask: async (input) => void asked.push(input.patterns),
    abort: new AbortController().signal,
    progress: () => undefined,
  })
  // Paused: routed copies wait in the queue, so no turn starts.
  yield* record({ status: "paused" })
  return { ...configured, project, id, inbox, ping, record, enter, call, asked }
})

const rule = (
  id: string,
  match: OperatorInboxRules.Match,
  action: OperatorInboxRules.Action,
): OperatorInboxRules.Rule => ({
  id,
  name: id,
  enabled: true,
  match,
  action,
})
const copiesOf = (id: string) =>
  OperatorQueueStore.store()
    .list({})
    .filter((item) => item.via?.id === id)

unix("the routing order: the first matching rule, then the manager, then as addressed, then dead letter", () =>
  Effect.gen(function* () {
    const { inbox, project, record, enter } = yield* setup()
    // A new inbox has "Replies go to their sender" first.
    expect((yield* inbox.inbox(project)).rules.map((item) => item.preset)).toEqual(["replies"])
    yield* inbox.setRules(project, [
      OperatorInboxRules.PRESETS.replies(),
      rule("urgent-to-plan", { priority: "urgent" }, { kind: "forward", to: [{ type: "agent", id: "plan" }] }),
      rule("bugs", { contains: "bug" }, { kind: "forward", to: [{ type: "agent", id: "build" }], priority: "high" }),
      rule("noise", { pattern: "^spam" }, { kind: "drop" }),
    ])

    // The first rule that matches decides: urgent before "bug".
    const urgent = yield* enter("a bug, urgently", { priority: "urgent" })
    expect(urgent).toMatchObject({ status: "routed", routedBy: "rule urgent-to-plan", routedTo: ["plan"] })
    expect(copiesOf(urgent.id)).toMatchObject([{ agent: "plan", correlationID: urgent.id, sender: { kind: "user" } }])
    const bug = yield* enter("found a bug")
    expect(bug.routedTo).toEqual(["build"])
    expect(copiesOf(bug.id)[0]!.priority).toBe("high")
    expect((yield* enter("spam spam")).status).toBe("dropped")

    // No rule, a manager: to the manager's main session, waiting for it.
    yield* record({ manager: "plan" })
    const managed = yield* enter("what next?", { to: { type: "agent", id: "build" } })
    expect(managed).toMatchObject({ status: "with manager", routedTo: ["plan"] })
    expect(copiesOf(managed.id)).toMatchObject([
      { agent: "plan", target: "main", via: { id: managed.id, manager: true } },
    ])

    // No rule, no manager: as addressed, else dead letter.
    yield* record({ manager: "" })
    expect(yield* enter("for build", { to: { type: "agent", id: "build" } })).toMatchObject({
      status: "routed",
      routedBy: "as addressed",
      routedTo: ["build"],
    })
    const dead = yield* enter("for nobody")
    expect(dead.status).toBe("dead letter")
    const logged = OperatorMessageLog.log().get(dead.id)!
    expect(logged).toMatchObject({ status: "dead letter", inbox: dead.inbox, from: { kind: "user" } })
    expect(logged.trail.map((step) => step.kind)).toEqual(["entered the Project inbox", "dead letter"])

    // The unmatched setting: broadcast to every member (the sender, the user, isn't one).
    yield* inbox.setUnmatched(project, "broadcast")
    yield* record({ members: ["build", "plan"] })
    const everyone = yield* enter("hello all")
    expect(everyone).toMatchObject({ status: "routed", routedBy: "broadcast", routedTo: ["build", "plan"] })

    // Counts for the Projects list.
    expect((yield* inbox.counts())[dead.inbox!]).toEqual({ waiting: 1, deadLetters: 1 })
  }),
)

unix("a rule can match the session a message was sent from (SPEC-0024)", () =>
  Effect.gen(function* () {
    const { inbox, project, id, enter } = yield* setup()
    const channel = rule(
      "channel",
      { fromSession: ["ses_channel"], recipient: { type: "agent", id: "plan" } },
      { kind: "forward", to: [{ type: "agent", id: "build" }] },
    )
    yield* inbox.setRules(project, [channel, OperatorInboxRules.PRESETS.replies()])
    expect(OperatorInboxRules.describe(channel)).toContain("from sessions ses_channel")

    // From that session: the rule decides, whatever the correlation id.
    const fromChannel = yield* enter("draft ready", {
      from: { kind: "agent", agent: "build", session: "ses_channel", project: id },
      to: { type: "agent", id: "plan" },
    })
    expect(fromChannel).toMatchObject({ status: "routed", routedBy: "rule channel", routedTo: ["build"] })
    expect(copiesOf(fromChannel.id)).toMatchObject([{ agent: "build" }])

    // The same agent from another session, and a message from outside: not this rule.
    const elsewhere = yield* enter("draft ready", {
      from: { kind: "agent", agent: "build", session: "ses_other", project: id },
      to: { type: "agent", id: "plan" },
    })
    expect(elsewhere).toMatchObject({ status: "routed", routedBy: "as addressed", routedTo: ["plan"] })
    const outside = yield* enter("draft ready", { from: { kind: "external" }, to: { type: "agent", id: "plan" } })
    expect(outside.routedBy).toBe("as addressed")

    // The rule test takes the sending session too.
    const tested = yield* inbox.test(project, {
      text: "draft ready",
      fromAgent: "build",
      fromSession: "ses_channel",
      to: { type: "agent", id: "plan" },
    })
    expect(tested).toMatchObject({ by: "rule", rule: { id: "channel" } })
    expect(
      (yield* inbox.test(project, { text: "draft ready", fromAgent: "build", to: { type: "agent", id: "plan" } })).by,
    ).toBe("as addressed")
  }),
)

unix("the presets: replies go to their sender's session; As addressed skips the manager", () =>
  Effect.gen(function* () {
    const { inbox, project, id, record, enter } = yield* setup()
    const sender = yield* session()
    yield* send(sender.id, "hi", "build")
    // A message build sent from its session (as ping does), and the user's reply to it through the inbox.
    const sent = yield* (yield* OperatorQueue.Service).send(
      "plan",
      { text: "review please" },
      { kind: "agent", agent: "build", sessionID: sender.id },
    )
    yield* record({ manager: "plan" })
    const reply = yield* enter("looks good", { replyTo: sent.id })
    expect(reply).toMatchObject({ status: "routed", routedBy: "rule Replies go to their sender", routedTo: ["build"] })
    expect(copiesOf(reply.id)).toMatchObject([{ agent: "build", target: "session", sessionID: sender.id }])
    // By correlation id too.
    expect((yield* enter("and one more", { correlationID: sent.correlationID! })).routedBy).toBe(
      "rule Replies go to their sender",
    )

    // With a manager, a message naming a recipient goes to the manager, unless As addressed is added.
    expect((yield* enter("for build", { to: { type: "agent", id: "build" } })).status).toBe("with manager")
    yield* inbox.setRules(project, [OperatorInboxRules.PRESETS.replies(), OperatorInboxRules.PRESETS["as-addressed"]()])
    expect(yield* enter("for build", { to: { type: "agent", id: "build" } })).toMatchObject({
      status: "routed",
      routedBy: "rule As addressed",
    })

    // Test: which rule would take a sample (saved rules, or the ones being edited).
    expect(yield* inbox.test(project, { text: "x", to: { type: "agent", id: "build" } })).toMatchObject({
      by: "rule",
      rule: { id: "as-addressed" },
    })
    expect(yield* inbox.test(project, { text: "x" })).toMatchObject({ by: "manager" })
    expect(yield* inbox.test(project, { text: "x" }, [])).toMatchObject({ by: "manager" })
    expect(id).toBeTruthy()
  }),
)

unix("rules are checked when saved; a rule can't name an inbox as a target", () =>
  Effect.gen(function* () {
    const { inbox, project } = yield* setup()
    const refused = (rules: OperatorInboxRules.Rule[]) =>
      inbox.setRules(project, rules).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      )
    expect(yield* refused([rule("bad", { pattern: "(" }, { kind: "drop" })])).toContain("isn't a regular expression")
    expect(yield* refused([rule("empty", {}, { kind: "forward", to: [] })])).toContain("forwards to nobody")
    expect(yield* refused([rule("a", {}, { kind: "drop" }), rule("a", {}, { kind: "drop" })])).toContain("Two rules")
    expect(yield* refused([rule("sender", {}, { kind: "to-sender" })])).toContain("must match replies")
    const decode = Schema.decodeUnknownExit(OperatorInboxRules.Rule)
    expect(
      decode({ ...rule("loop", {}, { kind: "drop" }), action: { kind: "forward", to: [{ type: "inbox", id: "x" }] } })
        ._tag,
    ).toBe("Failure")
  }),
)

unix("the manager's verbs: only the manager forwards, drops and changes rules; RULE asks", () =>
  Effect.gen(function* () {
    const { ping, call, record, enter, asked, project } = yield* setup()
    yield* record({ manager: "plan" })
    const waiting = yield* enter("route me")
    const planSession = (yield* session()).id

    // Not the manager.
    const notManager = yield* ping.run(
      call(
        { verb: "forward", messageID: waiting.id, to: [{ type: "agent", id: "build" }] },
        { sessionID: planSession, agent: "build" },
      ),
    )
    expect(notManager.card).toMatchObject({
      status: "refused",
      reason: "only the project's manager, plan, may forward",
    })

    // The manager forwards it (by the copy it got, too): routed, its trail shows who.
    const copy = copiesOf(waiting.id)[0]!
    const forwarded = yield* ping.run(
      call(
        { verb: "forward", messageID: copy.id, to: [{ type: "agent", id: "build" }] },
        { sessionID: planSession, agent: "plan" },
      ),
    )
    expect(forwarded.card).toMatchObject({ verb: "forward", status: "sent" })
    expect(asked.at(-1)).toEqual(["FORWARD(agent/build)"])
    const routed = OperatorMessageLog.log().get(waiting.id)!
    expect(routed).toMatchObject({ status: "routed", routedBy: "forwarded by plan", routedTo: ["build"] })
    expect(routed.trail.map((step) => step.kind)).toEqual(["entered the Project inbox", "with manager", "routed"])

    // Drop, with a reason.
    const other = yield* enter("drop me")
    const dropped = yield* ping.run(
      call({ verb: "drop", messageID: other.id, reason: "duplicate" }, { sessionID: planSession, agent: "plan" }),
    )
    expect(dropped.card.status).toBe("done")
    expect(OperatorMessageLog.log().get(other.id)!.trail.at(-1)).toMatchObject({
      kind: "dropped",
      detail: "by plan: duplicate",
    })

    // Rules: list doesn't ask; add asks RULE(add).
    const before = asked.length
    expect(
      (yield* ping.run(call({ verb: "rule", rule: { op: "list" } }, { sessionID: planSession, agent: "plan" }))).output,
    ).toContain("Replies go to their sender")
    expect(asked.length).toBe(before)
    const added = yield* ping.run(
      call(
        {
          verb: "rule",
          rule: {
            op: "add",
            id: "ops",
            name: "Ops",
            match: { contains: "deploy" },
            action: { kind: "forward", to: [{ type: "agent", id: "build" }] },
          },
        },
        { sessionID: planSession, agent: "plan" },
      ),
    )
    expect(added.output).toContain("2. [on] Ops (ops)")
    expect(asked.at(-1)).toEqual(["RULE(add)"])
    expect(
      (yield* OperatorProjectInbox.Service.pipe(Effect.flatMap((inbox) => inbox.inbox(project)))).rules.map(
        (r) => r.id,
      ),
    ).toEqual(["replies", "ops"])
  }),
)

unix("a dead letter: forward, broadcast, route again, and delete to Trash and back", () =>
  Effect.gen(function* () {
    const { inbox, project, enter, record } = yield* setup()
    const me = { kind: "user" } as const
    const one = yield* enter("lost one")
    expect((yield* inbox.forward(one.id, [{ type: "agent", id: "plan" }], me)).routedBy).toBe("forwarded by you")
    const two = yield* enter("lost two")
    expect((yield* inbox.broadcast(two.id, me)).routedBy).toBe("broadcast by you")

    // Route again after a rule is added.
    const three = yield* enter("lost three")
    yield* inbox.setRules(project, [rule("all", {}, { kind: "forward", to: [{ type: "agent", id: "build" }] })])
    const again = yield* inbox.routeAgain(three.id)
    expect(again).toMatchObject({ status: "routed", routedBy: "rule all" })
    expect(again.trail.at(-1)!.detail).toStartWith("routed again:")

    // Delete: to Trash, out of the log; restore puts it back.
    yield* inbox.setRules(project, [])
    const four = yield* enter("lost four")
    yield* inbox.remove(four.id)
    expect(OperatorMessageLog.log().get(four.id)).toBeUndefined()
    const entry = (yield* Effect.promise(() => OperatorTrashFiles.list())).find((item) => item.kind === "message")!
    expect(entry).toMatchObject({ name: "lost four", project })
    yield* (yield* OperatorTrash.Service).restore(entry.id)
    expect(OperatorMessageLog.log().get(four.id)).toMatchObject({ status: "dead letter" })

    // Only waiting messages and dead letters are acted on.
    expect((yield* inbox.forward(one.id, [{ type: "agent", id: "plan" }], me).pipe(Effect.flip)).message).toContain(
      "is routed",
    )
    yield* record({ status: "active" })
  }),
)

unix("a message past 8 inboxes is a dead letter (a routing loop)", () =>
  Effect.gen(function* () {
    const { enter } = yield* setup()
    const looped = yield* enter("round and round", { hops: OperatorProjectInbox.MAX_HOPS })
    expect(looped.status).toBe("dead letter")
    expect(looped.trail.at(-1)!.detail).toContain("routing loop")
  }),
)

unix("ping to the Project inbox; only the manager's request lists the manager's verbs", () =>
  Effect.gen(function* () {
    const { llm, ping, call, record } = yield* setup()
    yield* record({ status: "active", manager: "plan" })
    const sender = yield* session()
    const entered = yield* ping.run(
      call(
        { verb: "send", target: { type: "project_inbox" }, message: { body: "for whoever" } },
        { sessionID: sender.id, agent: "build" },
      ),
    )
    expect(entered.card.messages).toMatchObject([{ to: "the Project inbox", status: "with manager" }])
    const found = yield* ping.run(call({ verb: "discover" }, { sessionID: sender.id, agent: "build" }))
    expect(found.output).toContain("The Project inbox ({type: project_inbox}): its rules, else the manager plan")

    // The tool as each agent's request has it.
    type Body = { tools?: Array<{ function: { name: string; parameters: { properties: Record<string, any> } } }> }
    const pingOf = (body: unknown) => (body as Body).tools?.find((item) => item.function.name === "ping")?.function
    yield* llm.text("ok")
    yield* llm.text("ok")
    yield* send((yield* session()).id, "hello", "build")
    yield* send((yield* session()).id, "hello", "plan")
    const inputs = (yield* llm.inputs).filter((body) => pingOf(body))
    const verbs = inputs.map((body) => pingOf(body)!.parameters.properties.verb.enum)
    expect(verbs).toContainEqual(["discover", "send"])
    expect(verbs).toContainEqual(["discover", "send", "forward", "drop", "rule"])
    const build = inputs.find((body) => pingOf(body)!.parameters.properties.verb.enum.length === 2)!
    expect(Object.keys(pingOf(build)!.parameters.properties)).not.toContain("messageID")
  }),
)
