import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { OperatorRegistry } from "@/operator/registry"
import { OperatorTrashFiles } from "@/operator/trash-files"
import { OperatorTelemetryExport as X } from "@/operator/telemetry/export"
import type { OperatorTelemetryQuery } from "@/operator/telemetry/query"
import { OperatorTelemetry } from "@/operator/telemetry/telemetry"
import { OperatorTelemetryStore } from "@/operator/telemetry/store"
import { OperatorTelemetryViews as V } from "@/operator/telemetry/views"
import { tmpdir } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { replacements, root } from "../../merge/harness"
import { harness, T0 } from "./harness"

// observability_spec.md §8.5, §15, §16, §21.1: export (CSV quoting and formula prefixing, JSON Lines, the row limit,
// times with the viewer's offset); saved views (what they keep and never keep, built-ins first, deleted to Trash);
// Clear telemetry (the store to Trash, an empty one in its place) and restoring it (the current one to Trash first).

const context: OperatorTelemetryQuery.Context = {
  now: T0 + 60 * 60_000,
  known: [],
  stuckMinutes: 10,
  projectsOf: () => ({ keys: [], rest: true }),
}

function seeded(dir: string, count = 3) {
  const h = harness(dir)
  for (let n = 0; n < count; n++)
    h.batch().span({
      id: `tool:${n}`,
      kind: "tool_call",
      name: n === 0 ? "=HYPERLINK(evil)" : `execute_tool "bash", n${n}`,
      status: "error",
      start_ms: T0 + n,
      end_ms: T0 + n + 100,
      tool: "bash",
      error_message: n === 1 ? "line one\nline two" : null,
      tokens_input: 10,
      tokens_output: 5,
      source: "part",
    })
  h.flush()
  return h
}

const text = (chunks: Iterable<string>) => [...chunks].join("")

describe("export", () => {
  test("CSV: the visible columns, quoted and with formulas defused; tokens split; times with the offset", async () => {
    await using tmp = await tmpdir()
    const h = seeded(tmp.path)
    const csv = text(
      X.lines(h.store, {
        tab: "events",
        filter: { range: "24h" },
        context,
        sort: "start:asc",
        format: "csv",
        columns: ["start", "name", "tokens", "error", "nope"],
        offset: 120,
      }),
    )
    const rows = csv.split("\r\n")
    expect(rows[0]).toBe(
      "start_ms,name,tokens_input,tokens_cache_read,tokens_cache_write,tokens_output,tokens_reasoning,error_type,error_message",
    )
    // ISO 8601 with the viewer's offset (+02:00 here).
    expect(rows[1]!.startsWith(`${X.isoAt(T0, 120)},`)).toBe(true)
    expect(X.isoAt(T0, 120)).toMatch(/\+02:00$/)
    expect(rows[1]).toContain(",'=HYPERLINK(evil),10,,,5,,")
    expect(csv).toContain('"execute_tool ""bash"", n1"')
    expect(csv).toContain('"line one\nline two"')
    expect(X.cell(-3)).toBe("-3")
    expect(X.cell("@sum")).toBe("'@sum")
  })

  test("JSON Lines: every stored field, one object per row; the row limit stops it", async () => {
    await using tmp = await tmpdir()
    const h = seeded(tmp.path, 5)
    const lines = text(
      X.lines(h.store, { tab: "events", filter: { range: "24h" }, context, format: "jsonl", offset: 0 }, 3),
    )
      .trim()
      .split("\n")
    expect(lines).toHaveLength(3)
    const row = JSON.parse(lines[0]!)
    expect(row).toMatchObject({ kind: "tool_call", tool: "bash", tokens_input: 10 })
    expect(Object.keys(row)).toContain("args_hash")
    expect(X.count(h.store, { tab: "events", filter: { range: "24h" }, context })).toBe(5)
    expect(X.count(h.store, { tab: "events", filter: { range: "24h", status: "ok" }, context })).toBe(0)
    expect(X.LIMIT).toBe(100_000)
    expect(X.filename("events", "csv", { from: T0, to: T0 + 3_600_000 }, 0)).toMatch(
      /^opencode-events-\d{12}-\d{12}\.csv$/,
    )
  })
})

describe("saved views", () => {
  test("a view keeps the tab, filters, sort, columns and facets; never the range, scope or an open overlay", () => {
    expect(
      V.clean({
        tab: "events",
        params: {
          status: "error",
          sort: "start:desc",
          cols: "start,name",
          range: "7d",
          from: "1",
          ns: "acme",
          dir: "/work",
          session: "ses_1",
          span: "x",
          tool: "",
        },
        facets: true,
        expand: ["tool"],
      }),
    ).toEqual({
      tab: "events",
      params: { status: "error", sort: "start:desc", cols: "start,name" },
      facets: true,
      expand: ["tool"],
    })
    expect(V.clean({ tab: "nowhere", params: {} }).tab).toBe("sessions")
  })

  test("built-in views first, then the user's by name; a deleted view goes to Trash", async () => {
    const keys = V.BUILTINS.map((view) => view.builtin)
    expect(keys).toEqual([
      "errors",
      "denied",
      "awaiting",
      "rate_limited",
      "expensive",
      "slow_turns",
      "loops",
      "interrupted",
      "failing_tools",
    ])
    expect(V.BUILTINS.find((view) => view.builtin === "failing_tools")!.state.expand).toEqual(["tool"])
    const now = Date.now()
    const made = await V.write({
      id: V.newId(),
      name: "Zed's errors",
      state: { tab: "events", params: { status: "error" } },
      createdAt: now,
      updatedAt: now,
    })
    const other = await V.write({
      id: V.newId(),
      name: "Alpha",
      state: { tab: "logs", params: {} },
      createdAt: now,
      updatedAt: now,
    })
    const listed = await V.list()
    expect(listed.slice(0, 9).every((view) => view.builtin)).toBe(true)
    const users = listed.filter((view) => !view.builtin).map((view) => view.name)
    expect(users.indexOf("Alpha")).toBeLessThan(users.indexOf("Zed's errors"))
    const entry = await V.trash(made)
    expect(entry).toMatchObject({ kind: "telemetry-view", name: "Zed's errors" })
    expect((await V.list()).some((view) => view.id === made.id)).toBe(false)
    await V.trash(other)
  })
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(LayerNode.group([root, OperatorTelemetry.node]), [
    ...replacements,
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)

it.live("Clear telemetry moves the store to Trash; restoring it puts it back and the store then current in Trash", () =>
  Effect.gen(function* () {
    const telemetry = yield* OperatorTelemetry.Service
    const store = OperatorTelemetryStore.store()
    store.upsertSpan({ id: "keep:1", kind: "tool_call", name: "x", status: "ok", start_ms: Date.now(), source: "part" })
    const secret = store.meta("secret")
    const entry = yield* telemetry.clear()
    expect(entry).toMatchObject({ kind: "telemetry", name: "telemetry.sqlite" })
    // The same store object, now empty, with the same salt.
    expect(store.span("keep:1")).toBeUndefined()
    expect(store.meta("secret")).toBe(secret)
    store.upsertSpan({ id: "new:1", kind: "tool_call", name: "y", status: "ok", start_ms: Date.now(), source: "part" })
    // Restore as Trash does (trash.ts): files back, through the telemetry hook.
    yield* Effect.promise(() =>
      OperatorRegistry.telemetry.replaceStore!(async () => {
        for (const file of entry.files)
          await fs.rename(path.join(OperatorTrashFiles.root(), entry.id, file.stored), file.path)
      }),
    )
    expect(store.span("keep:1")).toMatchObject({ name: "x" })
    expect(store.span("new:1")).toBeUndefined()
    const trashed = (yield* Effect.promise(() => OperatorTrashFiles.list())).filter((item) => item.kind === "telemetry")
    expect(trashed.some((item) => item.id !== entry.id)).toBe(true)
    expect(telemetry.paused()).toBe(false)
  }),
)
