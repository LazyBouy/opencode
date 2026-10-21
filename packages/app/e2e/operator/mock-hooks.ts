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
  /** An agent's own hooks, listed (level agent) with the inherited ones when a list names the agent. */
  agentHooks: Array<ReturnType<typeof hookView>>
  paused: boolean
  timeout: number
  level: "global" | "namespace" | "project"
  runs: Array<Record<string, unknown>>
  scripts: string[]
  /** Every write, in order: its route and body. */
  writes: Array<{ route: string; body: Record<string, any> }>
  /** What Test answers next. */
  test: { outcome: string; answer: Record<string, unknown>; stdout?: string; cause?: string }
}

export function createHooksMock() {
  const state: HooksMockState = {
    hooks: [
      hookView("lint", "tool.after", {
        match: ["edit"],
        lastRun: { id: "hr.ses_1.lint", time: Date.now() - 60_000, outcome: "context" },
      }),
      hookView("date", "turn.before", { level: "namespace", file: "/work/acme/.opencode/opencode.jsonc" }),
      hookView("audit", "turn.after", { level: "global", file: "/home/me/.config/opencode/opencode.jsonc" }),
      hookView("policy", "tool.before", {
        level: "global",
        locked: true,
        file: "/home/me/.config/opencode/opencode.jsonc",
        match: ["bash"],
      }),
      hookView("old", "step.before", {
        level: "namespace",
        state: "off",
        offAt: "project",
        file: "/work/acme/.opencode/opencode.jsonc",
      }),
    ],
    agentHooks: [],
    paused: false,
    timeout: 5,
    level: "project",
    runs: [
      {
        id: "hr.ses_1.lint",
        time: Date.now() - 60_000,
        event: "tool.after",
        hook: "lint",
        level: "project",
        file: "/repo/opencode.json",
        sessionID: "ses_1",
        tool: "edit",
        outcome: "context",
        context: "0 problems",
        durationMs: 41,
        exitCode: 0,
      },
    ],
    scripts: ["/repo/.opencode/hooks/lint.sh"],
    writes: [],
    test: { outcome: "denied", answer: { allow: false, reason: "rm -rf is not allowed" }, stdout: '{"allow":false}' },
  }
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
  const fail = (route: Route, message: string) =>
    json(route, { name: "OperatorHookInvalidError", data: { message } }, 400)
  const handle = (route: Route, url: URL, method: string) => {
    const body = (() => {
      try {
        return (route.request().postDataJSON() ?? {}) as Record<string, any>
      } catch {
        return {}
      }
    })()
    if (method !== "GET") state.writes.push({ route: `${method} ${url.pathname}`, body })
    if (url.pathname === "/operator/hook" && method === "GET")
      return json(route, {
        hooks: url.searchParams.get("agent") ? [...state.hooks, ...state.agentHooks] : state.hooks,
        paused: state.paused,
        level: state.level,
        file: "/repo/.opencode/opencode.jsonc",
        folder: "/repo/.opencode/hooks",
        pluginsOff: false,
      })
    if (url.pathname === "/operator/hook" && method === "PUT") {
      const own = hookView(body.name, body.hook.event, {
        ...body.hook,
        command: `/repo/.opencode/${body.hook.command}`,
        script: body.hook.command,
        args: body.hook.args ?? [],
        match: body.hook.match ?? [],
        onFailure: body.hook.onFailure ?? "deny",
        locked: body.hook.locked === true,
        enabled: body.hook.enabled !== false,
        file: "/repo/.opencode/opencode.jsonc",
      })
      if (body.agent) {
        Object.assign(own, { level: "agent", file: `/repo/.opencode/agents/${body.agent}.md` })
        state.agentHooks = [...state.agentHooks.filter((item) => item.name !== body.name), own]
        return json(route, own)
      }
      state.hooks = [...state.hooks.filter((item) => item.name !== body.name && item.name !== body.previous), own]
      return json(route, own)
    }
    if (url.pathname === "/operator/hook/state") {
      const hook = state.hooks.find((item) => item.name === body.name)
      if (!hook) return fail(route, `No hook named ${body.name}`)
      if (hook.locked) return fail(route, `${body.name} is locked at ${hook.level}`)
      const level = body.agent ? "agent" : state.level
      Object.assign(hook, body.off ? { state: "off", offAt: level } : { state: "on", offAt: undefined })
      return json(route, hook)
    }
    if (url.pathname === "/operator/hook/remove") {
      state.hooks = state.hooks.filter((item) => item.name !== body.name)
      return json(route, true)
    }
    if (url.pathname === "/operator/hook/test") {
      const hook = state.hooks.find((item) => item.name === body.name)!
      return json(route, {
        run: {
          id: `hr.tests.${body.name}`,
          time: Date.now(),
          event: hook.event,
          hook: hook.name,
          level: hook.level,
          file: hook.file,
          outcome: state.test.outcome,
          exitCode: 0,
          durationMs: 12,
          test: true,
          ...(state.test.stdout ? { stdout: state.test.stdout } : {}),
        },
        outcome: state.test.outcome,
        answer: state.test.answer,
        ...(state.test.cause ? { cause: state.test.cause } : {}),
      })
    }
    if (url.pathname === "/operator/hook/sample") {
      const event = url.searchParams.get("event") ?? "tool.before"
      return json(route, {
        input: { event, hook: "example", level: "project", tool: "bash", input: { command: "ls" } },
      })
    }
    if (url.pathname === "/operator/hook/scripts") return json(route, state.scripts)
    if (url.pathname === "/operator/hook/script" && method === "GET") {
      const file = url.searchParams.get("path") ?? ""
      return json(route, {
        path: file,
        text: "#!/bin/sh\nexit 0\n",
        editable: file.startsWith("/repo/.opencode/hooks/"),
      })
    }
    if (url.pathname === "/operator/hook/script" && method === "POST") {
      const extension = { shell: ".sh", python: ".py", javascript: ".js" }[body.language as "shell"]
      const file = `/repo/.opencode/hooks/${body.name}${extension}`
      state.scripts.push(file)
      return json(route, { path: file, command: `hooks/${body.name}${extension}` })
    }
    if (url.pathname === "/operator/hook/script" && method === "PUT") return json(route, true)
    if (url.pathname === "/operator/hook/events") return json(route, HOOK_EVENTS)
    if (url.pathname === "/operator/hook/settings" && method === "PUT") {
      if (typeof body.paused === "boolean") state.paused = body.paused
      if (typeof body.timeout === "number") state.timeout = body.timeout
      return json(route, { timeout: state.timeout, paused: state.paused })
    }
    if (url.pathname === "/operator/hook/settings") return json(route, { timeout: state.timeout, paused: state.paused })
    if (url.pathname === "/operator/hook/runs") {
      const session = url.searchParams.get("session")
      const event = url.searchParams.get("event")
      const hook = url.searchParams.get("hook")
      const runs = state.runs
        .filter((run) => !session || run.sessionID === session)
        .filter((run) => !event || run.event === event)
        .filter((run) => !hook || run.hook === hook)
        .toSorted((a, b) => Number(b.time) - Number(a.time))
      return json(route, { runs, total: runs.length })
    }
    const one = url.pathname.match(/^\/operator\/hook\/runs\/(.+)$/)
    if (one) {
      const run = state.runs.find((item) => item.id === decodeURIComponent(one[1]!))
      return run ? json(route, run) : json(route, { name: "OperatorHookNotFoundError", data: { message: "gone" } }, 404)
    }
    return json(route, { name: "NotFound", data: { message: url.pathname } }, 404)
  }
  return { state, handle }
}
