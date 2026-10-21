import type { Route } from "@playwright/test"

// Hooks' API for the e2e mock (SPEC-0022 §11): the hooks in force, the events and the run log, answered as the
// server would, from state a test can change.

const fields = (...names: string[]) => names
export const HOOK_EVENTS = [
  { name: "session.created", kind: "watch", fields: fields(), group: "session" },
  {
    name: "prompt.submitted",
    kind: "blocking",
    fields: fields("allow", "reason", "prompt", "context"),
    group: "prompt",
  },
  { name: "turn.before", kind: "blocking", fields: fields("allow", "reason", "context"), group: "prompt" },
  { name: "step.before", kind: "blocking", fields: fields("allow", "reason", "context"), group: "step" },
  { name: "step.after", kind: "watch", fields: fields(), group: "step" },
  {
    name: "tool.before",
    kind: "blocking",
    fields: fields("allow", "reason", "input", "context"),
    group: "tool",
    subject: "tool",
  },
  { name: "tool.after", kind: "blocking", fields: fields("output", "context"), group: "tool", subject: "tool" },
  {
    name: "subagent.before",
    kind: "blocking",
    fields: fields("allow", "reason", "prompt", "context"),
    group: "tool",
    subject: "agent",
  },
  { name: "subagent.after", kind: "blocking", fields: fields("output", "context"), group: "tool", subject: "agent" },
  {
    name: "permission.asked",
    kind: "blocking",
    fields: fields("allow", "reason"),
    group: "permission",
    subject: "permission",
  },
  { name: "compaction.before", kind: "blocking", fields: fields("context"), group: "compaction" },
  { name: "compaction.after", kind: "blocking", fields: fields("continue"), group: "compaction" },
  { name: "turn.after", kind: "watch", fields: fields(), group: "watch" },
  { name: "session.error", kind: "watch", fields: fields(), group: "watch" },
  { name: "file.edited", kind: "watch", fields: fields(), group: "watch" },
  { name: "session.deleted", kind: "watch", fields: fields(), group: "session" },
]

export const hookView = (name: string, event: string, extra: Record<string, unknown> = {}) => ({
  name,
  event,
  command: `/repo/hooks/${name}.sh`,
  script: `hooks/${name}.sh`,
  args: [],
  match: [],
  onFailure: "deny",
  locked: false,
  enabled: true,
  level: "project",
  file: "/repo/opencode.json",
  state: "on",
  problems: [],
  ...extra,
})

export type HooksMockState = {
  hooks: Array<ReturnType<typeof hookView>>
  paused: boolean
  runs: Array<Record<string, unknown>>
}

export function createHooksMock() {
  const state: HooksMockState = {
    hooks: [
      hookView("lint", "tool.after", { match: ["edit"] }),
      hookView("date", "turn.before", { level: "namespace", file: "/work/acme/.opencode/opencode.jsonc" }),
      hookView("audit", "turn.after", { level: "global", file: "/home/me/.config/opencode/opencode.jsonc" }),
      hookView("old", "step.before", { state: "off", offAt: "project" }),
    ],
    paused: false,
    runs: [],
  }
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
  const handle = (route: Route, url: URL, method: string) => {
    if (url.pathname === "/operator/hook" && method === "GET")
      return json(route, { hooks: state.hooks, paused: state.paused })
    if (url.pathname === "/operator/hook/events") return json(route, HOOK_EVENTS)
    if (url.pathname === "/operator/hook/settings") return json(route, { timeout: 5, paused: state.paused })
    if (url.pathname === "/operator/hook/runs") {
      const session = url.searchParams.get("session")
      const event = url.searchParams.get("event")
      const runs = state.runs
        .filter((run) => !session || run.sessionID === session)
        .filter((run) => !event || run.event === event)
        .toSorted((a, b) => Number(b.time) - Number(a.time))
      return json(route, { runs, total: runs.length })
    }
    return json(route, { name: "NotFound", data: { message: url.pathname } }, 404)
  }
  return { state, handle }
}
