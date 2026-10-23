import type { Route } from "@playwright/test"

// The Project inbox's API for the e2e mock (SPEC-0023 §11): a project's inbox messages, rules and settings, a
// message's record and actions, and Settings → Messaging, answered as the server would, from state a test changes.

type Message = {
  id: string
  project: string
  from: { kind: string; project?: string; agent?: string; session?: string }
  to: { type: string; id?: string }
  body: { type: string; text: string }
  priority: string
  steer: boolean
  correlationID: string
  hops: number
  status: string
  inbox: string
  createdAt: number
  routedBy?: string
  routedTo?: string[]
  trail: Array<{ at: number; kind: string; detail?: string }>
  copies?: Array<{ id: string; agent?: string; sessionID?: string; status: string }>
}
type Rule = {
  id: string
  name: string
  enabled: boolean
  preset?: string
  match: Record<string, unknown>
  action: { kind: string; to?: Array<{ type: string; id: string }> }
}

export type InboxMockState = {
  messages: Message[]
  rules: Rule[]
  unmatched: "dead-letter" | "broadcast"
  manager?: string
  settings: { perMinute: number; perHour: number; wait: number }
  /** Every write: the action and its body. */
  writes: Array<{ action: string; id?: string; body?: unknown }>
}

const at = Date.now()
const message = (id: string, text: string, status: string, extra: Partial<Message> = {}): Message => ({
  id,
  project: "proj_smoke_timeline",
  from: { kind: "user", project: "proj_smoke_timeline" },
  to: { type: "inbox" },
  body: { type: "text", text },
  priority: "normal",
  steer: false,
  correlationID: id,
  hops: 1,
  status,
  inbox: "proj_smoke_timeline",
  createdAt: at - 60_000,
  trail: [{ at: at - 60_000, kind: "entered the Project inbox", detail: "from you" }],
  ...extra,
})

export function createInboxMock() {
  const state: InboxMockState = {
    messages: [
      message("msg_routed", "Review the release notes", "routed", {
        from: { kind: "agent", agent: "build", session: "ses_op_1", project: "proj_smoke_timeline" },
        routedBy: "rule Docs",
        routedTo: ["plan"],
        createdAt: at - 300_000,
        copies: [{ id: "msg_copy", agent: "plan", sessionID: "ses_op_2", status: "delivered" }],
      }),
      message("msg_waiting", "What should we do about the flaky test?", "with manager", {
        routedBy: "the manager",
        routedTo: ["plan"],
        createdAt: at - 120_000,
      }),
      message("msg_dead", "Who owns the billing page?", "dead letter", {
        trail: [
          { at: at - 60_000, kind: "entered the Project inbox", detail: "from you" },
          {
            at: at - 60_000,
            kind: "dead letter",
            detail: "no rule matched, the project has no manager, and it names no recipient",
          },
        ],
      }),
    ],
    rules: [
      {
        id: "replies",
        name: "Replies go to their sender",
        enabled: true,
        preset: "replies",
        match: { reply: true },
        action: { kind: "to-sender" },
      },
      {
        id: "docs",
        name: "Docs",
        enabled: true,
        match: { contains: "release notes" },
        action: { kind: "forward", to: [{ type: "agent", id: "plan" }] },
      },
    ],
    unmatched: "dead-letter",
    settings: { perMinute: 30, perHour: 300, wait: 120 },
    writes: [],
  }
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
  const body = (route: Route) => (route.request().postDataJSON() ?? {}) as Record<string, any>
  const settings = () => ({
    unmatched: state.unmatched,
    ...(state.manager ? { manager: state.manager } : {}),
    transport: "sqlite",
  })
  const step = (found: Message, kind: string, detail: string) =>
    (found.trail = [...found.trail, { at: Date.now(), kind, detail }])

  function handle(route: Route, url: URL, method: string) {
    const path = url.pathname
    if (path === "/operator/messaging/status")
      return json(route, {
        memoryLane: { backend: "in-process", held: 2, cap: 200 },
        inboxTransport: "sqlite",
        rabbitmq: "not configured",
        redis: "not configured",
        outbox: 0,
      })
    if (path === "/operator/messaging/settings") {
      if (method === "PUT") {
        const patch = body(route)
        state.writes.push({ action: "messaging-settings", body: patch })
        if (patch.perMinute !== undefined && (patch.perMinute < 1 || patch.perMinute > 1000))
          return json(
            route,
            { name: "OperatorProjectInboxInvalidError", data: { message: "perMinute must be 1 to 1000" } },
            400,
          )
        state.settings = { ...state.settings, ...patch }
      }
      return json(route, state.settings)
    }
    if (path === "/operator/messaging/counts") {
      const count = (status: string) => state.messages.filter((item) => item.status === status).length
      return json(route, {
        proj_smoke_timeline: { waiting: count("with manager"), deadLetters: count("dead letter") },
      })
    }
    const inbox = path.match(/^\/operator\/project-inbox\/([^/]+)(\/messages|\/rules|\/rules\/test|\/settings)?$/)
    if (inbox) {
      const part = inbox[2]
      if (!part && method === "POST") {
        const sent = body(route)
        const id = `msg_new_${state.messages.length + 1}`
        const made = message(id, sent.text, state.manager ? "with manager" : sent.to ? "routed" : "dead letter", {
          ...(sent.to ? { to: sent.to } : {}),
          createdAt: Date.now(),
        })
        state.writes.push({ action: "enter", body: sent })
        state.messages.push(made)
        return json(route, made)
      }
      if (part === "/messages") {
        const status = url.searchParams.get("status")
        return json(
          route,
          state.messages
            .filter((item) => !status || item.status === status)
            .toSorted((a, b) => b.createdAt - a.createdAt),
        )
      }
      if (part === "/rules") {
        if (method === "PUT") {
          state.rules = body(route).rules
          state.writes.push({ action: "rules", body: state.rules })
        }
        return json(route, { rules: state.rules, unmatched: state.unmatched })
      }
      if (part === "/rules/test") {
        const { sample, rules } = body(route)
        const list = (rules ?? state.rules) as Rule[]
        const found = list.find(
          (rule) =>
            rule.enabled &&
            typeof rule.match.contains === "string" &&
            String(sample.text).toLowerCase().includes(String(rule.match.contains).toLowerCase()),
        )
        if (found)
          return json(route, {
            by: "rule",
            rule: { id: found.id, name: found.name },
            detail: `${found.name}: ${found.action.kind}`,
          })
        return json(
          route,
          state.manager
            ? { by: "manager", detail: "No rule matches: to the manager" }
            : { by: "dead letter", detail: "No rule matches: dead letter" },
        )
      }
      if (part === "/settings") {
        if (method === "PUT") {
          state.unmatched = body(route).unmatched
          state.writes.push({ action: "settings", body: { unmatched: state.unmatched } })
        }
        return json(route, settings())
      }
    }
    const record = path.match(/^\/operator\/messages\/([^/]+)(\/forward|\/drop|\/route-again|\/broadcast)?$/)
    if (record) {
      const id = decodeURIComponent(record[1]!)
      const found = state.messages.find((item) => item.id === id)
      if (!found)
        return json(route, { name: "OperatorProjectInboxNotFoundError", data: { message: `No message ${id}` } }, 404)
      const action = record[2]
      if (!action && method === "GET") return json(route, found)
      if (!action && method === "DELETE") {
        state.writes.push({ action: "remove", id })
        state.messages = state.messages.filter((item) => item.id !== id)
        return json(route, true)
      }
      if (action === "/forward") {
        const to = body(route).to as Array<{ type: string; id: string }>
        state.writes.push({ action: "forward", id, body: { to } })
        Object.assign(found, { status: "routed", routedBy: "forwarded by you", routedTo: to.map((item) => item.id) })
        step(found, "routed", `forwarded by you: to ${to.map((item) => item.id).join(", ")}`)
      } else if (action === "/drop") {
        state.writes.push({ action: "drop", id, body: body(route) })
        Object.assign(found, { status: "dropped", routedBy: "you" })
        step(found, "dropped", `by you: ${body(route).reason || "no reason given"}`)
      } else if (action === "/route-again") {
        state.writes.push({ action: "route-again", id })
        step(found, "dead letter", "routed again: no rule matched")
      } else if (action === "/broadcast") {
        state.writes.push({ action: "broadcast", id })
        Object.assign(found, { status: "routed", routedBy: "broadcast by you", routedTo: ["build", "plan"] })
        step(found, "routed", "broadcast by you: to build, plan")
      }
      return json(route, found)
    }
    return undefined
  }
  return { state, handle }
}
