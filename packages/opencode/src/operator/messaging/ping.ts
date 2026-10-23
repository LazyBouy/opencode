export * as OperatorPing from "./ping"

import path from "path"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { OperatorPermissionEffective } from "../permission-effective"
import { OperatorPermissionModel } from "../permission-model"
import { OperatorProjectRecords } from "../project-records"
import { OperatorProjects } from "../projects"
import { OperatorQueue } from "../queue"
import type { OperatorQueueStore } from "../queue-store"
import { OperatorPingDefaults } from "./defaults"
import { OperatorMessageLanes } from "./lanes"
import { OperatorMessageLog } from "./log"
import { OperatorMessage } from "./message"
import { OperatorMessagingSeams } from "./seams"

// What the `ping` tool does (SPEC-0023 §7), inside a project: `discover` what the agent may send to, and `send` to
// an agent, a session or a group, through the queue's lanes (queue.ts), optionally waiting for the reply. The tool
// itself, its permission asks and its offer are in seams.ts; this module never imports session code. Permissions
// are the `ping` lines with verbs (`SEND(agent/writer)`), decided from the session's effective lines (cached,
// permission-live.ts); on top of them the sender and the recipients must be members of the project. A send counts
// against the sending agent's rate limits, a group as one.

export const VERBS = ["DISCOVER", "SEND"] as const
OperatorPermissionEffective.declareVerbs("ping", VERBS)
// Offered only where a line allows it (seams.ts): the OpenCode namespace has none (ADR-0005).
OperatorPermissionEffective.declareOptIn("ping")

export const LIMITS = {
  /** Sends per sending agent and project (§9.3). */
  perMinute: 30,
  perHour: 300,
  /** Recipients of one group send or broadcast (§8.4). */
  recipients: 50,
  /** `wait`, in seconds (§7.4). */
  wait: 120,
  waitMax: 1800,
} as const

export const TARGETS = ["agent", "session", "group"] as const
export type Target = { type: (typeof TARGETS)[number]; id?: string; session?: string }

export type Args = {
  verb: "discover" | "send"
  target?: Target
  message?: { type?: OperatorMessage.Body["type"]; body: string }
  priority?: OperatorQueueStore.Priority
  steer?: boolean
  correlationID?: string
  replyTo?: string
  wait?: boolean
  timeout?: number
}

/** What a `ping` call's part carries (`metadata.ping`), for its card in the session views. */
export type Card = {
  verb: Args["verb"]
  /** What was asked for, e.g. `agent writer`, `group reviewers`, `reply to msg_…`. */
  target?: string
  status: "listed" | "sent" | "refused" | "waiting" | "replied" | "no reply"
  reason?: string
  messages?: Array<{ id?: string; to: string; status: string; reason?: string }>
  correlationID?: string
  wait?: { since: number; timeout: number; from?: string }
  reply?: { id: string; from: string; text: string }
}

export type Call = {
  sessionID: string
  agent: string
  args: Args
  /** The tool's permission ask (`ctx.ask`): resolves when allowed, throws when denied or rejected. */
  ask: (input: { patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>
  abort: AbortSignal
  /** Updates the running call's card. */
  progress: (title: string, card: Card) => void
}
export type Result = { title: string; output: string; card: Card }

export const DESCRIPTION = [
  "Send messages to the other agents of this project, and to your own other sessions.",
  "- discover: lists the agents (and whether each is running) and groups you may send to.",
  "- send: sends message.body to target: an agent ({type: agent, id: name}, optionally its session), a session ({type: session, id: ses_…}) or a group ({type: group, id: name}: one message per member). A blank id sends to every agent, or every group.",
  "The recipient sees who sent the message, with its id and correlation id. A message for a session that is running reads at its turn's end, unless steer is true (read at its next step); one for an idle session starts its next turn, so each message costs the recipient a model turn.",
  "To answer a message you received, send with replyTo set to its id: the reply goes to the sender's session, whatever target says.",
  `wait: true keeps this call waiting for the reply (same correlation id), up to timeout seconds (default ${LIMITS.wait}, at most ${LIMITS.waitMax}); you spend that time waiting. Never wait on your own session.`,
  `At most ${LIMITS.perMinute} sends a minute and ${LIMITS.perHour} an hour; a group send counts as one, with at most ${LIMITS.recipients} recipients.`,
].join("\n")

// Sends by sending agent and project, for the rate limits (times, the last hour's).
const sends = new Map<string, number[]>()
function limited(key: string, now: number) {
  const recent = (sends.get(key) ?? []).filter((at) => now - at < 3_600_000)
  sends.set(key, recent)
  if (recent.length >= LIMITS.perHour) return `${LIMITS.perHour} sends an hour`
  if (recent.filter((at) => now - at < 60_000).length >= LIMITS.perMinute) return `${LIMITS.perMinute} sends a minute`
  return undefined
}
const counted = (key: string, now: number) => sends.set(key, [...(sends.get(key) ?? []), now])
/** For tests: forget the sends counted. */
export const resetLimits = () => sends.clear()

const refused = (verb: Args["verb"], reason: string, target?: string): Result => ({
  title: "refused",
  output: `Refused: ${reason}`,
  card: { verb, ...(target ? { target } : {}), status: "refused", reason },
})

export interface Interface {
  readonly run: (call: Call) => Effect.Effect<Result, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorPing") {}

type Recipient = { agent: string; sessionID?: string; to: string }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const seams = yield* OperatorMessagingSeams.Service
    const queue = yield* OperatorQueue.Service

    yield* Effect.promise(() => OperatorPingDefaults.ensure().catch(() => false))

    // How the session's lines decide an input (deny when none matches, as the fork's asks are decided).
    const decider = (sessionID: string, agent: string) =>
      Effect.gen(function* () {
        const handler = OperatorPermissionEffective.handlers.effective
        const found = handler ? yield* handler({ sessionID, agent }).pipe(Effect.option) : undefined
        const lines = found?._tag === "Some" ? found.value.lines : undefined
        return (pattern: string): "allow" | "ask" | "deny" =>
          lines ? OperatorPermissionModel.decide(lines, "ping", pattern).action : "ask"
      })

    // The project's agents a message can go to: its members, else every agent that runs sessions of its own.
    const agentsOf = (record: OperatorProjectRecords.Record) =>
      seams
        .agents()
        .pipe(
          Effect.map((all) =>
            record.members.length
              ? all.filter((agent) => record.members.includes(agent.name))
              : all.filter((agent) => agent.mode !== "subagent" && !agent.hidden),
          ),
        )

    const discover = Effect.fnUntraced(function* (call: Call, project: string, record: OperatorProjectRecords.Record) {
      const decide = yield* decider(call.sessionID, call.agent)
      // Listed when discovering it isn't denied and sending to it could be allowed.
      const shown = (target: string) => {
        const discovering = decide(`DISCOVER(${target})`)
        return discovering !== "deny" && decide(`SEND(${target})`) !== "deny" ? discovering : undefined
      }
      const asks: string[] = []
      const agents: string[] = []
      for (const agent of yield* agentsOf(record)) {
        const action = shown(`agent/${agent.name}`)
        if (!action) continue
        if (action === "ask") asks.push(`DISCOVER(agent/${agent.name})`)
        const destination = yield* seams.destination({ agent: agent.name, target: "active" }, false)
        const running = typeof destination !== "string" && (yield* seams.running(destination))
        const about = agent.description ? ` — ${agent.description.replace(/\s+/g, " ").slice(0, 200)}` : ""
        agents.push(
          `- ${agent.name}${agent.name === call.agent ? " (you)" : ""}${about} · ${running ? "running" : "idle"}`,
        )
      }
      const groups: string[] = []
      for (const group of record.groups) {
        const action = shown(`group/${group.name}`)
        if (!action) continue
        if (action === "ask") asks.push(`DISCOVER(group/${group.name})`)
        groups.push(`- ${group.name}: ${group.members.join(", ") || "no members"}`)
      }
      if (asks.length)
        yield* Effect.promise(() =>
          call.ask({
            patterns: asks,
            always: asks,
            metadata: { description: "List the agents and groups you may message" },
          }),
        )
      const name = path.basename(project)
      const output = [
        `Agents of project ${name} you may message:`,
        ...(agents.length ? agents : ["(none)"]),
        ...(groups.length ? ["Groups:", ...groups] : []),
      ].join("\n")
      return {
        title: `${agents.length} agents, ${groups.length} groups`,
        output,
        card: { verb: "discover", status: "listed" },
      } satisfies Result
    })

    const send = Effect.fnUntraced(function* (call: Call, project: string, record: OperatorProjectRecords.Record) {
      const args = call.args
      const body = args.message?.body?.trim() ?? ""
      if (!body) return refused("send", "the message is empty (message.body)")
      const limitKey = `${project}\n${call.agent}`
      const over = limited(limitKey, Date.now())
      if (over) return refused("send", `the rate limit: at most ${over}`)
      const decide = yield* decider(call.sessionID, call.agent)

      // Who it goes to, the permission patterns that decide it, and what the card says it was for.
      let recipients: Recipient[] = []
      let pattern: string
      let label: string
      let correlationID = args.correlationID
      let anyone = false
      if (args.replyTo) {
        // A reply goes to the original sender's session, with its correlation id (§7.4, §9.2).
        const original = OperatorMessageLog.log().get(args.replyTo)
        label = `reply to ${args.replyTo}`
        if (!original || original.folder !== project) return refused("send", `no message ${args.replyTo} here`, label)
        if (original.agent !== call.agent) return refused("send", `${args.replyTo} was not sent to you`, label)
        if (original.from.kind !== "agent" || !original.from.agent || !original.from.session)
          return refused("send", `${args.replyTo} didn't come from an agent's session; answer in your reply`, label)
        recipients = [{ agent: original.from.agent, sessionID: original.from.session, to: original.from.agent }]
        pattern = `agent/${original.from.agent}`
        correlationID = original.correlationID
      } else {
        const target = args.target
        if (!target) return refused("send", "say who it's for (target)")
        const id = target.id?.trim()
        if (target.type === "session") {
          label = `session ${id ?? ""}`.trim()
          if (!id) return refused("send", "name the session (target.id)", label)
          const found = yield* seams.session(id)
          if (!found) return refused("send", `no session ${id} here`, label)
          // A session records its agent when it first runs; the caller's own runs now.
          const agent = found.agent ?? (id === call.sessionID ? call.agent : undefined)
          if (!agent) return refused("send", `session ${id} hasn't run yet`, label)
          recipients = [{ agent, sessionID: id, to: `${agent} (session ${id})` }]
          pattern = `agent/${agent}`
        } else if (target.type === "agent") {
          const agents = yield* agentsOf(record)
          if (!id) {
            // Every agent of the project but the sender.
            label = "every agent"
            pattern = "agent/*"
            recipients = agents
              .filter((agent) => agent.name !== call.agent && decide(`SEND(agent/${agent.name})`) !== "deny")
              .map((agent) => ({ agent: agent.name, to: agent.name }))
            anyone = true
          } else {
            label = `agent ${id}`
            if (!(yield* seams.agents()).some((agent) => agent.name === id))
              return refused("send", `no agent ${id}`, label)
            if (target.session) {
              const found = yield* seams.session(target.session)
              if (!found) return refused("send", `no session ${target.session} here`, label)
              if (found.agent && found.agent !== id)
                return refused("send", `session ${target.session} runs as ${found.agent}, not ${id}`, label)
            }
            recipients = [{ agent: id, ...(target.session ? { sessionID: target.session } : {}), to: id }]
            pattern = `agent/${id}`
          }
        } else {
          // A group: one message per member but the sender; a blank id, every group's members.
          const groups = id ? record.groups.filter((group) => group.name === id || group.id === id) : record.groups
          label = id ? `group ${groups[0]?.name ?? id}` : "every group"
          if (!groups.length)
            return refused("send", id ? `no group ${id} in this project` : "this project has no groups", label)
          pattern = id ? `group/${groups[0].name}` : "group/*"
          const members = [...new Set(groups.flatMap((group) => group.members))].filter((name) => name !== call.agent)
          recipients = members.map((name) => ({ agent: name, to: name }))
          anyone = true
        }
      }
      if (decide(`SEND(${pattern})`) === "deny")
        return refused("send", `the ping permission denies SEND(${pattern})`, label)
      if (!recipients.length) return refused("send", "nobody to send it to", label)
      if (recipients.length > LIMITS.recipients)
        return refused("send", `${recipients.length} recipients; at most ${LIMITS.recipients}`, label)

      // Waiting on its own session could never be answered (§7.4).
      const waits = !!args.wait
      if (waits) {
        for (const recipient of recipients) {
          const destination = recipient.sessionID
            ? recipient.sessionID
            : yield* seams.defaultTarget(recipient.agent).pipe(
                Effect.flatMap((target) => seams.destination({ agent: recipient.agent, target }, false)),
                Effect.map((found) => (typeof found === "string" ? undefined : found.id)),
                Effect.orElseSucceed(() => undefined),
              )
          if (destination === call.sessionID)
            return refused("send", "waiting on your own session; it could never answer", label)
        }
      }

      yield* Effect.promise(() =>
        call.ask({
          patterns: [`SEND(${pattern})`],
          always: [`SEND(${pattern.includes("/") ? `${pattern.split("/")[0]}/*` : pattern})`],
          metadata: { description: `Message ${label}`, text: body.slice(0, 2000) },
        }),
      )

      const firstID = OperatorMessage.newId()
      correlationID ??= firstID
      const timeout = Math.min(Math.max(Math.round(args.timeout ?? LIMITS.wait), 1), LIMITS.waitMax)
      // Registered before anything is sent, so a quick reply can't pass it by.
      const from = recipients.length === 1 && !anyone ? recipients[0].agent : undefined
      const waiting = waits
        ? OperatorMessageLanes.lane().wait({
            sessionID: call.sessionID,
            accepts: (item) =>
              item.correlationID === correlationID &&
              item.sender.sessionID !== call.sessionID &&
              (!from || item.sender.agent === from),
          })
        : undefined

      const to: OperatorMessage.To = args.replyTo
        ? { type: "session", id: recipients[0].sessionID! }
        : args.target!.type === "group"
          ? { type: "group", ...(args.target!.id ? { id: args.target!.id } : {}) }
          : args.target!.type === "session"
            ? { type: "session", id: args.target!.id! }
            : { type: "agent", ...(args.target!.id ? { id: args.target!.id } : {}) }
      const messages: NonNullable<Card["messages"]> = []
      for (const [at, recipient] of recipients.entries()) {
        const sent = yield* queue
          .send(
            recipient.agent,
            {
              text: body,
              ...(recipient.sessionID ? { target: "session" as const, sessionID: recipient.sessionID } : {}),
              priority: args.priority ?? "normal",
              steer: args.steer ?? false,
              correlationID,
              ...(args.replyTo ? { replyTo: args.replyTo } : {}),
            },
            { kind: "agent", agent: call.agent, sessionID: call.sessionID },
            { ...(at === 0 ? { id: firstID } : {}), to, body: args.message?.type ?? "text" },
          )
          .pipe(
            Effect.map((item) => ({ id: item.id, to: recipient.to, status: item.status })),
            Effect.catch((error) => Effect.succeed({ to: recipient.to, status: "refused", reason: error.message })),
          )
        messages.push(sent)
      }
      const delivered = messages.filter((item) => item.id)
      if (!delivered.length) {
        waiting?.cancel()
        return {
          title: "refused",
          output: messages.map((item) => `${item.to}: refused (${item.reason})`).join("\n"),
          card: { verb: "send", target: label, status: "refused", messages, reason: messages[0]?.reason },
        } satisfies Result
      }
      counted(limitKey, Date.now())
      const lines = messages.map((item) =>
        item.id ? `${item.id} → ${item.to}: ${item.status}` : `${item.to}: refused (${item.reason})`,
      )
      const sentCard: Card = { verb: "send", target: label, status: "sent", messages, correlationID }
      if (!waiting)
        return {
          title: `${label}: ${delivered.length === 1 ? delivered[0].status : `${delivered.length} sent`}`,
          output: [...lines, `correlation ${correlationID}`].join("\n"),
          card: sentCard,
        } satisfies Result

      // The wait: the reply, the timeout, or the session's abort, whichever comes first.
      const since = Date.now()
      const wait = { since, timeout, ...(from ? { from } : {}) }
      call.progress(`Waiting for a reply from ${from ?? label}`, { ...sentCard, status: "waiting", wait })
      const outcome = yield* Effect.promise(
        () =>
          new Promise<OperatorQueueStore.Item | "timeout" | "aborted">((resolve) => {
            const finish = (value: OperatorQueueStore.Item | "timeout" | "aborted") => {
              clearTimeout(timer)
              call.abort.removeEventListener("abort", onAbort)
              resolve(value)
            }
            const onAbort = () => finish("aborted")
            const timer = setTimeout(() => finish("timeout"), timeout * 1000)
            call.abort.addEventListener("abort", onAbort, { once: true })
            if (call.abort.aborted) onAbort()
            void waiting.reply.then(finish)
          }),
      ).pipe(Effect.ensuring(Effect.sync(() => waiting.cancel())))
      if (outcome === "aborted") return yield* Effect.fail(new Error("The session was stopped while ping waited"))
      if (outcome === "timeout")
        return {
          title: `no reply within ${timeout} s`,
          output: [...lines, `correlation ${correlationID}`, `No reply within ${timeout} s.`].join("\n"),
          card: { ...sentCard, status: "no reply", wait },
        } satisfies Result
      const replier = outcome.sender.agent ?? "someone"
      return {
        title: `reply from ${replier}`,
        output: [...lines, `correlation ${correlationID}`, `Reply from ${replier} (${outcome.id}):`, outcome.text].join(
          "\n",
        ),
        card: {
          ...sentCard,
          status: "replied",
          wait,
          reply: { id: outcome.id, from: replier, text: outcome.text.slice(0, 4000) },
        },
      } satisfies Result
    })

    const run = Effect.fn("OperatorPing.run")(function* (call: Call) {
      const ctx = yield* InstanceState.context
      const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const record = yield* Effect.promise(() => OperatorProjectRecords.get(project))
      if (record.members.length && !record.members.includes(call.agent))
        return refused(call.args.verb, `${call.agent} is not a member of this project`)
      if (call.args.verb === "discover") return yield* discover(call, project, record)
      if (call.args.verb === "send") return yield* send(call, project, record)
      return refused(call.args.verb, `unknown verb ${String(call.args.verb)}`)
    })

    yield* OperatorMessagingSeams.servePing(run)
    return Service.of({ run })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [OperatorMessagingSeams.node, OperatorQueue.node],
})
