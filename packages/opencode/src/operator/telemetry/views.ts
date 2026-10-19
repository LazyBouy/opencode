export * as OperatorTelemetryViews from "./views"

import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorTelemetryFiles } from "./files"

// Saved views (observability_spec.md §8.5): a tab, its filters and sort, the visible columns and the facet panel,
// never the time range or scope, so a view works for any period or project. Built-in views are read-only (Save as
// copies one); the user's are one JSON file each in `<data>/operator/telemetry-views/` (files.ts), shared by everyone
// on this server (one password, no accounts), deleted to Trash.

export type State = {
  tab: string
  /** Filters (§7.2 names), `sort` and `cols`, as the page's URL has them. */
  params: Record<string, string>
  /** The facet panel open or not. */
  facets?: boolean
  /** Facets showing all their values. */
  expand?: string[]
}
export type View = {
  id: string
  name: string
  description?: string
  state: State
  /** A built-in view's key (its name is the page's text for it). */
  builtin?: string
  createdBy?: string
  createdAt: number
  updatedAt: number
}

export const BUILTIN_PREFIX = "builtin-"
// Page parameters a view may hold (§8.4): the filters, sort and columns; never range, scope or what an overlay shows.
const KEEP = new Set([
  "agent",
  "agentType",
  "model",
  "provider",
  "tool",
  "mcp",
  "kind",
  "status",
  "errorType",
  "finish",
  "decision",
  "minCost",
  "maxCost",
  "minDuration",
  "maxDuration",
  "minTokens",
  "loop",
  "http",
  "q",
  "roots",
  "sessionStatus",
  "stuck",
  "inSession",
  "level",
  "service",
  "sort",
  "cols",
  "by",
  "compare",
])
export const TABS = ["sessions", "events", "metrics", "logs", "alerts"] as const

const builtin = (key: string, state: State): View => ({
  id: `${BUILTIN_PREFIX}${key}`,
  name: key,
  builtin: key,
  state,
  createdAt: 0,
  updatedAt: 0,
})
export const BUILTINS: ReadonlyArray<View> = [
  builtin("errors", { tab: "events", params: { status: "error", sort: "start:desc" } }),
  builtin("denied", { tab: "events", params: { status: "denied", sort: "start:desc" } }),
  builtin("awaiting", { tab: "events", params: { kind: "permission_wait", status: "running", sort: "start:asc" } }),
  builtin("rate_limited", { tab: "events", params: { http: "429", sort: "start:desc" } }),
  builtin("expensive", { tab: "sessions", params: { sort: "cost:desc" } }),
  builtin("slow_turns", { tab: "events", params: { kind: "turn", sort: "active:desc" } }),
  builtin("loops", { tab: "events", params: { kind: "turn", loop: "1", sort: "start:desc" } }),
  builtin("interrupted", { tab: "events", params: { status: "interrupted", sort: "start:desc" } }),
  builtin("failing_tools", {
    tab: "events",
    params: { kind: "tool_call", status: "error", sort: "start:desc" },
    facets: true,
    expand: ["tool"],
  }),
]

/** A view's state with only what a view keeps. */
export function clean(state: State): State {
  const params = Object.fromEntries(
    Object.entries(state.params ?? {}).filter(
      ([key, value]) => KEEP.has(key) && typeof value === "string" && value !== "",
    ),
  )
  return {
    tab: (TABS as ReadonlyArray<string>).includes(state.tab) ? state.tab : "sessions",
    params,
    ...(state.facets !== undefined ? { facets: state.facets } : {}),
    ...(state.expand?.length ? { expand: state.expand.filter((item) => typeof item === "string") } : {}),
  }
}

export const dir = () => path.join(Global.Path.data, "operator", "telemetry-views")

const valid = (value: unknown): value is View => {
  const view = value as Partial<View> | undefined
  return !!view && typeof view.id === "string" && typeof view.name === "string" && typeof view.state === "object"
}

const files = OperatorTelemetryFiles.folder(dir, valid)

/** The built-in views, then the user's by name. */
export async function list(): Promise<View[]> {
  const users = (await files.list())
    .filter((view) => !view.id.startsWith(BUILTIN_PREFIX))
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt)
  return [...BUILTINS, ...users]
}

export const get = async (id: string) => (await list()).find((view) => view.id === id)
export const write = (view: View) => files.write({ ...view, state: clean(view.state) })
export const newId = () => OperatorTelemetryFiles.newId("view")
export const trash = (view: View) => files.trash(view, { kind: "telemetry-view", name: view.name })
