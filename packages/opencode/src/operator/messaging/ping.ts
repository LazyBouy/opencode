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
import { OperatorProjectInbox } from "./inbox"
import { OperatorMessageLanes } from "./lanes"
import { OperatorMessageLog } from "./log"
import { OperatorMessage } from "./message"
import { OperatorInboxRules as Rules } from "./rules"
import { OperatorMessagingSeams } from "./seams"
import { OperatorMessagingSettings } from "./settings"
import { OperatorPingVerbs } from "./verbs"

// What the `ping` tool does (SPEC-0023 §7, §8.3), inside a project: `discover` what the agent may send to, and
// `send` to an agent, a session, a group or the Project inbox (inbox.ts), through the queue's lanes (queue.ts),
// optionally waiting for the reply; the project's manager also `forward`s and `drop`s what its inbox gave it, and
// changes the inbox's `rule`s. The tool itself, its permission asks and its offer are in seams.ts; this module
// never imports session code. Permissions are the `ping` lines with verbs (`SEND(agent/writer)`), decided from the
// session's effective lines (cached, permission-live.ts); on top of them the sender and the recipients must be
// members of the project. A send counts against the sending agent's rate limits (Settings → Messaging), a group
// as one.

export const VERBS = ["DISCOVER", "SEND", "FORWARD", "DROP", "RULE"] as const
OperatorPermissionEffective.declareVerbs("ping", VERBS)
// Offered only where a line allows it (seams.ts): the OpenCode namespace has none (ADR-0005).
OperatorPermissionEffective.declareOptIn("ping")

export const LIMITS = {
  /** Recipients of one group send or broadcast (§8.4). */
  recipients: OperatorProjectInbox.MAX_RECIPIENTS,
  /** The longest `wait`, in seconds (§7.4); the default is in Settings → Messaging. */
  waitMax: OperatorMessagingSettings.WAIT_MAX,
} as const

/** The manager's verbs (§8.3): offered only to the project's manager. */
export const MANAGER_VERBS = OperatorPingVerbs.MANAGER
export const TARGETS = ["agent", "session", "group", "project_inbox"] as const
export type Target = { type: (typeof TARGETS)[number]; id?: string; session?: string }

/** The `rule` verb's input: what to do with the inbox's rules. */
export type RuleArgs = {
  op: "list" | "add" | "change" | "on" | "off" | "remove"
  id?: string
  name?: string
  /** add: where in the list (0 is first; default: last). */
  position?: number
  match?: Rules.Match
  action?: Rules.Action
}

export type Args = {
  verb: "discover" | "send" | (typeof MANAGER_VERBS)[number]
  target?: Target
  message?: { type?: OperatorMessage.Body["type"]; body: string }
  priority?: OperatorQueueStore.Priority
  steer?: boolean
  correlationID?: string
  replyTo?: string
  wait?: boolean
  timeout?: number
  /** forward, drop: the Project inbox message (or the copy the manager got). */
  messageID?: string
  /** forward: where to. */
  to?: Rules.Target[]
  /** drop: why. */
  reason?: string
  rule?: RuleArgs
}

/** What a `ping` call's part carries (`metadata.ping`), for its card in the session views. */
export type Card = {
  verb: Args["verb"]
  /** What was asked for, e.g. `agent writer`, `group reviewers`, `reply to msg_…`. */
  target?: string
  status: "listed" | "sent" | "done" | "refused" | "waiting" | "replied" | "no reply"
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
  "Send messages to the other agents of this project, to its Project inbox, and to your own other sessions.",
  "- discover: lists the agents (and whether each is running), the groups and the Project inbox you may send to.",
  "- send: sends message.body to target: an agent ({type: agent, id: name}, optionally its session), a session ({type: session, id: ses_…}), a group ({type: group, id: name}: one message per member) or the Project inbox ({type: project_inbox}: its rules, else its manager, decide where it goes). A blank id sends to every agent, or every group.",
  "The recipient sees who sent the message, with its id and correlation id. A message for a session that is running reads at its turn's end, unless steer is true (read at its next step); one for an idle session starts its next turn, so each message costs the recipient a model turn.",
  "To answer a message you received, send with replyTo set to its id: the reply goes to the sender's session, whatever target says.",
  `wait: true keeps this call waiting for the reply (same correlation id), up to timeout seconds (at most ${LIMITS.waitMax}); you spend that time waiting. Never wait on your own session.`,
  `Sends are rate-limited per agent; a group send counts as one, with at most ${LIMITS.recipients} recipients.`,
  "Only the project's manager: forward (messageID, to: agents, sessions or groups) and drop (messageID, reason) a message the Project inbox gave you to route; rule (rule.op: list, add, change, on, off, remove) changes the inbox's rules.",
].join("\n")

// Sends by sending agent and project, for the rate limits (times, the last hour's).
const sends = new Map<string, number[]>()
function limited(key: string, now: number, settings: OperatorMessagingSettings.Settings) {
  const recent = (sends.get(key) ?? []).filter((at) => now - at < 3_600_000)
  sends.set(key, recent)
  if (recent.length >= settings.perHour) return `${settings.perHour} sends an hour`
  if (recent.filter((at) => now - at < 60_000).length >= settings.perMinute)
    return `${settings.perMinute} sends a minute`
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
    const inbox = yield* OperatorProjectInbox.Service

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
      const inboxShown = shown("inbox")
      if (inboxShown === "ask") asks.push("DISCOVER(inbox)")
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
        ...(inboxShown
          ? [
              `The Project inbox ({type: project_inbox}): ${record.manager ? `its rules, else the manager ${record.manager}` : "its rules"} route what it gets.`,
            ]
          : []),
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
      const settings = yield* Effect.promise(() => OperatorMessagingSettings.read())
      const over = limited(limitKey, Date.now(), settings)
      if (over) return refused("send", `the rate limit: at most ${over}`)
      const decide = yield* decider(call.sessionID, call.agent)

      // Who it goes to, the permission patterns that decide it, and what the card says it was for.
      let recipients: Recipient[] = []
      let pattern: string
      let label: string
      let correlationID = args.correlationID
      let anyone = false
      let toInbox = false
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
        if (target.type === "project_inbox") {
          label = "the Project inbox"
          pattern = "inbox"
          toInbox = true
          anyone = true
        } else if (target.type === "session") {
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
      if (!recipients.length && !toInbox) return refused("send", "nobody to send it to", label)
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
      const timeout = Math.min(Math.max(Math.round(args.timeout ?? settings.wait), 1), LIMITS.waitMax)
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

      const messages: NonNullable<Card["messages"]> = []
      if (toInbox) {
        // The inbox routes it now (§8.1): routed, with the manager, a dead letter or dropped.
        const entered = yield* inbox
          .enter({
            project,
            from: {
              kind: "agent",
              agent: call.agent,
              session: call.sessionID,
              project: yield* Effect.promise(() => OperatorProjectInbox.projectIdOf(project)),
            },
            body: { type: args.message?.type ?? "text", text: body },
            priority: args.priority ?? "normal",
            steer: args.steer ?? false,
            correlationID,
          })
          .pipe(
            Effect.map((message) => ({ id: message.id, to: label, status: message.status })),
            Effect.catch((error) => Effect.succeed({ to: label, status: "refused", reason: error.message })),
          )
        messages.push(entered)
        // Nobody will answer a dead letter or a dropped message.
        if (entered.status !== "routed" && entered.status !== "with manager") waiting?.cancel()
      }
      const to: OperatorMessage.To = args.replyTo
        ? { type: "session", id: recipients[0].sessionID! }
        : args.target!.type === "group"
          ? { type: "group", ...(args.target!.id ? { id: args.target!.id } : {}) }
          : args.target!.type === "session"
            ? { type: "session", id: args.target!.id! }
            : { type: "agent", ...(args.target!.id ? { id: args.target!.id } : {}) }
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
      if (!waiting || (toInbox && messages[0]?.status !== "routed" && messages[0]?.status !== "with manager"))
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

    // The manager's verbs (§8.3): refused for any other agent; each asks its permission line first.
    const asked = (call: Call, verb: "FORWARD" | "DROP" | "RULE", targets: string[], description: string) =>
      Effect.gen(function* () {
        const decide = yield* decider(call.sessionID, call.agent)
        const patterns = targets.map((target) => `${verb}(${target})`)
        const denied = patterns.find((pattern) => decide(pattern) === "deny")
        if (denied) return `the ping permission denies ${denied}`
        const always = [
          ...new Set(targets.map((target) => `${verb}(${target.includes("/") ? `${target.split("/")[0]}/*` : "*"})`)),
        ]
        yield* Effect.promise(() => call.ask({ patterns, always, metadata: { description } }))
        return undefined
      })

    const forward = Effect.fnUntraced(function* (call: Call, project: string) {
      const id = call.args.messageID?.trim()
      if (!id) return refused("forward", "name the message (messageID)")
      const to = call.args.to ?? []
      if (!to.length) return refused("forward", "say where to forward it (to)", id)
      const no = yield* asked(
        call,
        "FORWARD",
        to.map((target) => `${target.type}/${target.id}`),
        `Forward ${id}`,
      )
      if (no) return refused("forward", no, id)
      const outcome = yield* inbox.forward(id, to, { kind: "agent", agent: call.agent }, project).pipe(
        Effect.map((message) => ({ message })),
        Effect.catch((error) => Effect.succeed({ error: error.message })),
      )
      if ("error" in outcome) return refused("forward", outcome.error, id)
      const where = outcome.message.routedTo?.join(", ") ?? ""
      return {
        title: `forwarded ${outcome.message.id}`,
        output: `${outcome.message.id}: ${outcome.message.status}, to ${where}`,
        card: {
          verb: "forward",
          target: id,
          status: "sent",
          messages: [{ id: outcome.message.id, to: where, status: outcome.message.status }],
        },
      } satisfies Result
    })

    const drop = Effect.fnUntraced(function* (call: Call, project: string) {
      const id = call.args.messageID?.trim()
      if (!id) return refused("drop", "name the message (messageID)")
      const no = yield* asked(call, "DROP", [id], `Drop ${id}`)
      if (no) return refused("drop", no, id)
      const outcome = yield* inbox.drop(id, call.args.reason ?? "", { kind: "agent", agent: call.agent }, project).pipe(
        Effect.map((message) => ({ message })),
        Effect.catch((error) => Effect.succeed({ error: error.message })),
      )
      if ("error" in outcome) return refused("drop", outcome.error, id)
      return {
        title: `dropped ${outcome.message.id}`,
        output: `${outcome.message.id}: dropped`,
        card: { verb: "drop", target: id, status: "done" },
      } satisfies Result
    })

    const rule = Effect.fnUntraced(function* (call: Call, project: string) {
      const input = call.args.rule
      if (!input) return refused("rule", "say what to do (rule.op: list, add, change, on, off, remove)")
      const current = (yield* inbox.inbox(project)).rules
      const listed = (rules: ReadonlyArray<Rules.Rule>) =>
        rules.length ? rules.map((item, at) => `${at + 1}. ${Rules.describe(item)}`).join("\n") : "No rules."
      if (input.op === "list")
        return {
          title: `${current.length} rules`,
          output: listed(current),
          card: { verb: "rule", status: "listed" },
        } satisfies Result
      const found = input.id ? current.find((item) => item.id === input.id) : undefined
      if (input.op !== "add" && !found)
        return refused("rule", input.id ? `no rule ${input.id}` : "name the rule (rule.id)")
      const no = yield* asked(call, "RULE", [input.op], `${input.op} a Project inbox rule`)
      if (no) return refused("rule", no)
      const next: Rules.Rule[] = (() => {
        if (input.op === "add") {
          const made: Rules.Rule = {
            id: input.id?.trim() || `r_${Date.now().toString(36)}`,
            name: input.name?.trim() || "Rule",
            enabled: true,
            match: input.match ?? {},
            action: input.action ?? { kind: "manager" },
          }
          const at = Math.min(Math.max(input.position ?? current.length, 0), current.length)
          return [...current.slice(0, at), made, ...current.slice(at)]
        }
        if (input.op === "remove") return current.filter((item) => item.id !== found!.id)
        return current.map((item) =>
          item.id !== found!.id
            ? item
            : input.op === "change"
              ? {
                  ...item,
                  ...(input.name ? { name: input.name } : {}),
                  ...(input.match ? { match: input.match } : {}),
                  ...(input.action ? { action: input.action } : {}),
                }
              : { ...item, enabled: input.op === "on" },
        )
      })()
      const saved = yield* inbox.setRules(project, next).pipe(
        Effect.map((value) => ({ value })),
        Effect.catch((error) => Effect.succeed({ error: error.message })),
      )
      if ("error" in saved) return refused("rule", saved.error)
      return {
        title: `rule ${input.op}`,
        output: listed(saved.value.rules),
        card: { verb: "rule", target: input.op, status: "done" },
      } satisfies Result
    })

    const run = Effect.fn("OperatorPing.run")(function* (call: Call) {
      const ctx = yield* InstanceState.context
      const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const record = yield* Effect.promise(() => OperatorProjectRecords.get(project))
      if (record.members.length && !record.members.includes(call.agent))
        return refused(call.args.verb, `${call.agent} is not a member of this project`)
      const verb = call.args.verb
      if (verb === "discover") return yield* discover(call, project, record)
      if (verb === "send") return yield* send(call, project, record)
      if (verb === "forward" || verb === "drop" || verb === "rule") {
        if (record.manager !== call.agent)
          return refused(
            verb,
            record.manager
              ? `only the project's manager, ${record.manager}, may ${verb}`
              : `this project has no manager; only a manager may ${verb}`,
          )
        if (verb === "forward") return yield* forward(call, project)
        if (verb === "drop") return yield* drop(call, project)
        return yield* rule(call, project)
      }
      return refused(verb, `unknown verb ${String(verb)}`)
    })

    yield* OperatorMessagingSeams.servePing(run)
    return Service.of({ run })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [OperatorMessagingSeams.node, OperatorQueue.node, OperatorProjectInbox.node],
})
