import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator, pendingRequest } from "./mock-operator"

// dashboard_spec.md §13.2: All clear with the running count; each attention item's words and link (the parameters,
// not just the page), "+N more" and the "alert firing" badge; a permission asked through an event shows within 3 s;
// range and scope in the URL, on every block but the strip, and carried by tile links; comparisons' arrows, words and
// tones; panels' rows (the session overlay, Observability links), Other rows and "+N more"; telemetry off, building
// history and an unreachable server.

const pending: unknown[] = []

test.beforeEach(async ({ page }) => {
  pending.length = 0
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    events: () => pending.splice(0),
    eventRetry: 200,
  })
})

type Mock = Awaited<ReturnType<typeof mockOperator>>
const last = (state: Mock, path: string) => state.telemetry.queries.findLast((query) => query.path === path)?.params
const hrefOf = async (page: Page, testId: string) => {
  const href = await page.getByTestId(testId).getAttribute("href")
  const url = new URL(href!, "http://x")
  return { path: url.pathname, params: Object.fromEntries(url.searchParams) }
}
const item = (kind: string, fields: Record<string, unknown>) => ({
  kind,
  severity: "warning",
  count: 1,
  worst: {},
  alert: false,
  link: { page: "observability", params: {} },
  ...fields,
})

test("all clear, the server chip, tiles with their comparisons and links, and the panels", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator")

  await expect(page.getByTestId("dash-server")).toContainText("Running")
  await expect(page.getByTestId("dash-server")).toContainText("1.18.34-fork")
  await expect(page.getByTestId("dash-all-clear")).toContainText("All clear. Nothing needs you. 1 session running.")

  // Turn errors went down 0.8 points: better, so the good tone, with its arrow and words.
  const errors = page.getByTestId("dash-tile-turnErrors")
  await expect(errors).toContainText("3.1%")
  await expect(errors.locator('[data-slot="operator-stat-change"]')).toHaveAttribute("data-tone", "good")
  await expect(errors.locator('[data-slot="operator-stat-change"]')).toContainText("▼ 0.8 pts vs prev. 14 d")
  await expect(errors).toContainText("37 failed · 12 denied · tool errors 4.1%")
  // Rate limits went up: worse. Turns went up too, but it is neutral.
  await expect(page.getByTestId("dash-tile-rateLimits").locator('[data-slot="operator-stat-change"]')).toHaveAttribute(
    "data-tone",
    "warn",
  )
  await expect(page.getByTestId("dash-tile-turns").locator('[data-slot="operator-stat-change"]')).toHaveAttribute(
    "data-tone",
    "neutral",
  )
  // The tile is one link named by its full sentence, into Observability with the range.
  const link = page.getByRole("link", {
    name: "Turn errors 3.1%, down 0.8 percentage points from the previous 14 days",
  })
  await expect(link).toBeVisible()
  const href = new URL((await link.getAttribute("href"))!, "http://x")
  expect([href.pathname, Object.fromEntries(href.searchParams)]).toEqual([
    "/operator/observability",
    { range: "14d", tab: "events", kind: "turn", status: "error,interrupted" },
  ])
  await expect(page.getByTestId("dash-tile-turnTime")).toContainText("p50 18 s · first token p95 2.1 s")
  await expect(page.getByTestId("dash-tile-rateLimits")).toContainText("31 retries · context p95 64% · 3 compactions")
  await expect(page.getByTestId("dash-tile-turns").getByRole("img")).toHaveAttribute(
    "aria-label",
    /^Turns: from 40 to 52$/,
  )

  // Running now: the running session, what it's doing.
  const running = page.locator('[data-slot="operator-dash-panel"]').filter({ hasText: "Running now" })
  await expect(running.getByRole("row", { name: /Session 3/ })).toContainText("execute_tool bash")
  // Agents: badges for subagents and helpers, and the rest combined.
  const agents = page.locator('[data-slot="operator-dash-panel"]').filter({ hasText: "Agents" })
  await expect(agents.getByRole("row", { name: /explore/ })).toContainText("Subagent")
  await expect(agents.getByRole("row", { name: /title/ })).toContainText("Helper")
  await agents.getByRole("row", { name: /Other \(5 agents\)/ }).click()
  await expect(page).toHaveURL(/\/operator\/observability\?/)
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
    tab: "sessions",
    agent: "a1,a2,a3,a4,a5",
    range: "14d",
  })
})

test("panels: a session row opens the overlay, a tool its calls, MCP tools under their server", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator")
  const tools = page.locator('[data-slot="operator-dash-panel"]').filter({ hasText: "Tools" })
  await expect(tools).toContainText("github › search")
  await expect(tools.locator("li").filter({ hasText: "github › search" })).toContainText("⚠ 11.3% errors")
  await expect(tools.getByTestId("dash-tools-other")).toContainText("+14 others → Observability")
  await tools.getByRole("button", { name: "bash" }).click()
  await expect(page).toHaveURL(/tool=bash/)
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
    tab: "events",
    kind: "tool_call",
    tool: "bash",
  })
  await page.goBack()
  const recent = page.locator('[data-slot="operator-dash-panel"]').filter({ hasText: "Recent sessions" })
  await expect(recent.getByRole("row")).toHaveCount(9)
  await recent.getByRole("row", { name: /Fix the failing test/ }).click()
  await expect(page).toHaveURL(/session=ses_main/)
  await expect(page.getByRole("dialog")).toBeVisible()
})

test("each attention item says its worst case and links to the place to act; +N more; alert badges", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.telemetry.dashboard.items = [
    item("approvals", {
      count: 2,
      severity: "critical",
      worst: { ageMs: 35 * 60_000 },
      alert: true,
      link: { page: "inbox", params: {} },
    }),
    item("alerts", {
      count: 3,
      severity: "critical",
      worst: { label: "Rate limited", critical: 1 },
      link: { page: "observability", params: { tab: "alerts" } },
    }),
    item("errors", {
      count: 3,
      link: {
        page: "observability",
        params: { tab: "sessions", sessionStatus: "error,interrupted,denied", range: "24h" },
      },
    }),
    item("stuck", { worst: { ageMs: 25 * 60_000 }, link: { page: "observability", params: { session: "ses_03" } } }),
    item("loops", {
      link: { page: "observability", params: { tab: "events", kind: "turn", loop: "1", range: "24h" } },
    }),
    item("rate_limited", {
      count: 7,
      worst: { label: "anthropic" },
      link: { page: "observability", params: { tab: "events", http: "429", range: "15m" } },
    }),
    item("mcp", {
      severity: "critical",
      worst: { label: "github", status: "needs_auth", ageMs: 60_000 },
      link: { page: "capabilities", params: { dir: directory, tab: "mcp", kind: "mcp", item: "github" } },
    }),
    item("queue", {
      count: 4,
      worst: { ageMs: 18 * 60_000 },
      link: { page: "observability", params: { tab: "events", kind: "queue_item", status: "running" } },
    }),
  ]
  await page.goto("/operator")
  const strip = page.getByTestId("dash-attention")
  await expect(strip.getByRole("heading", { name: "Needs attention" })).toBeVisible()
  await expect(page.getByTestId("dash-item-approvals")).toContainText("Critical")
  await expect(page.getByTestId("dash-item-approvals")).toContainText("2 approvals waiting · oldest 35 min")
  await expect(page.getByTestId("dash-item-approvals-alert")).toHaveText("alert firing")
  await expect(page.getByTestId("dash-item-alerts")).toContainText("3 alerts firing · 1 critical")
  await expect(page.getByTestId("dash-item-stuck")).toContainText("1 session hasn't progressed for 25 min")
  await expect(page.getByTestId("dash-item-rate_limited")).toContainText("Rate limited: 7 in 15 min (anthropic)")
  // Six on one line, then "+2 more".
  await expect(strip.locator('[data-slot="operator-dash-item"]')).toHaveCount(6)
  await page.getByTestId("dash-attention-more").click()
  await expect(strip.locator('[data-slot="operator-dash-item"]')).toHaveCount(8)
  await expect(page.getByTestId("dash-item-mcp")).toContainText("MCP: github needs sign-in")
  await expect(page.getByTestId("dash-item-queue")).toContainText("Queue: 4 waiting · oldest 18 min")
  // Links: the page and its parameters.
  expect(await hrefOf(page, "dash-item-errors")).toEqual({
    path: "/operator/observability",
    params: { tab: "sessions", sessionStatus: "error,interrupted,denied", range: "24h" },
  })
  expect(await hrefOf(page, "dash-item-rate_limited")).toEqual({
    path: "/operator/observability",
    params: { tab: "events", http: "429", range: "15m" },
  })
  expect(await hrefOf(page, "dash-item-mcp")).toEqual({
    path: "/operator/capabilities",
    params: { dir: directory, tab: "mcp", kind: "mcp", item: "github" },
  })
  expect(await hrefOf(page, "dash-item-approvals")).toEqual({ path: "/operator/inbox", params: {} })
})

test("live: a permission asked shows in the strip within 3 s, and the live region says so", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator")
  await expect(page.getByTestId("dash-all-clear")).toBeVisible()
  state.telemetry.dashboard.items = [
    item("approvals", { worst: { ageMs: 30_000 }, link: { page: "inbox", params: { ask: "per_op_1" } } }),
  ]
  pending.push({
    directory,
    payload: { id: "evt_dash_asked", type: "permission.asked", properties: { ...pendingRequest.request } },
  })
  await expect(page.getByTestId("dash-item-approvals")).toContainText("1 approval waiting · 1 min", { timeout: 3000 })
  await expect(page.getByTestId("dash-attention-live")).toHaveText("1 approval waiting · 1 min")
  expect(await hrefOf(page, "dash-item-approvals")).toEqual({ path: "/operator/inbox", params: { ask: "per_op_1" } })
})

test("range and scope: in the URL, on the tiles and panels, not the strip; tile links carry them", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator?dir=${encodeURIComponent(directory)}`)
  await expect(page.getByTestId("dash-tile-turns")).toContainText("1,204")
  expect(last(state, "/attention")?.get("dir")).toBe(directory)
  expect(last(state, "/attention")?.get("range")).toBeNull()
  await page.getByTestId("dash-range").getByRole("button", { name: "7 days" }).click()
  await expect(page).toHaveURL(/range=7d/)
  await expect.poll(() => last(state, "/tiles")?.get("range")).toBe("7d")
  await expect.poll(() => last(state, "/breakdown")?.get("range")).toBe("7d")
  expect(last(state, "/breakdown")?.get("by")).toBe("agent,tool")
  expect(last(state, "/tiles")?.get("dir")).toBe(directory)
  await expect(page.getByTestId("dash-tile-turnErrors")).toContainText("vs prev. 7 d")
  const tile = page.getByTestId("dash-tile-cost").locator('[data-slot="operator-stat-link"]')
  const href = new URL((await tile.getAttribute("href"))!, "http://x")
  expect(Object.fromEntries(href.searchParams)).toEqual({
    dir: directory,
    range: "7d",
    tab: "metrics",
    section: "tokens",
  })
  // The range is remembered.
  await page.goto("/operator")
  await expect(page.getByTestId("dash-range").getByRole("button", { name: "7 days" })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
})

test("telemetry off: approvals from the pending list, sessions without status, the rest says so", async ({ page }) => {
  const state = await mockOperator(page)
  state.telemetry.settings.enabled = false
  // Asked two minutes ago, now (the mock's own clock is fixed when it loads).
  state.pending = [{ ...pendingRequest, time: Date.now() - 120_000 }]
  await page.goto("/operator")
  await expect(page.getByTestId("dash-item-telemetry")).toContainText("Telemetry is off: tiles can't update")
  await expect(page.getByTestId("dash-item-approvals")).toContainText("1 approval waiting · 2 min")
  expect(await hrefOf(page, "dash-item-approvals")).toEqual({ path: "/operator/inbox", params: { ask: "per_op_1" } })
  await expect(page.getByTestId("dash-tile-turns")).toContainText("—")
  await expect(page.getByTestId("dash-tile-turns")).toContainText("Telemetry is off")
  const running = page.locator('[data-slot="operator-dash-panel"]').filter({ hasText: "Running now" })
  await expect(running.getByTestId("dash-telemetry-off")).toContainText("Telemetry is off Observability settings")
  const recent = page.locator('[data-slot="operator-dash-panel"]').filter({ hasText: "Recent sessions" })
  await expect(recent).toContainText("Fix the parser")
})

test("building history, and an unreachable server with Retry", async ({ page }) => {
  const state = await mockOperator(page)
  state.telemetry.backfill = { state: "running", done: 20, total: 50 }
  let down = true
  await page.route("**/operator/telemetry/attention**", (route) =>
    down ? route.fulfill({ status: 500, body: "{}" }) : route.fallback(),
  )
  await page.goto("/operator")
  await expect(page.getByTestId("dash-unreachable")).toContainText("Can't reach the server.")
  down = false
  await page.getByTestId("dash-unreachable").getByRole("button", { name: "Retry" }).click()
  await expect(page.getByTestId("dash-building")).toContainText("Building history from your sessions… 40%.")
})

test("no turns in the range: the tiles say so instead of comparing zeros", async ({ page }) => {
  const state = await mockOperator(page)
  state.telemetry.dashboard.tiles = {
    turns: { value: 0, previous: 0, change: { kind: "same" } },
    turnErrors: { value: null, previous: null, change: { kind: "insufficient" } },
  }
  await page.goto("/operator?range=7d")
  const turns = page.getByTestId("dash-tile-turns")
  await expect(turns.locator('[data-slot="operator-stat-value"]')).toHaveText("—")
  await expect(turns).toContainText("No turns in the last 7 days")
  await expect(turns.locator('[data-slot="operator-stat-change"]')).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Turn errors: No turns in the last 7 days" })).toBeVisible()
})

const chart = (page: Page, id: string) => page.locator(`[data-testid="obs-chart"][data-metric="dash-${id}"]`)
const lastMetric = (state: Mock, metric: string) =>
  state.telemetry.queries.findLast((query) => query.path === "/metrics" && query.params.get("metric") === metric)
    ?.params

test("Activity: turns by outcome with totals; a step opens its turns; dragging zooms the page, Reset goes back", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator?range=7d")
  const activity = chart(page, "activity")
  await expect(activity.getByRole("heading", { level: 2, name: "Activity: turns by outcome" })).toBeVisible()
  await expect(activity.locator('[data-slot="operator-chart-legend"]')).toContainText(/OK · \d+/)
  await expect(activity.locator('[data-slot="operator-chart-legend"]')).toContainText(/Error · \d+/)
  expect(lastMetric(state, "turns")?.get("range")).toBe("7d")
  // The bottom of the stack is OK: its turns in that hour, in Observability.
  const over = activity.locator(".u-over")
  await expect(over).toBeVisible()
  let box = (await over.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3)
  await expect(page).toHaveURL(/\/operator\/observability\?.*tab=events/)
  const url = new URL(page.url())
  expect([url.searchParams.get("kind"), url.searchParams.get("status")]).toEqual(["turn", "ok"])
  expect(Number(url.searchParams.get("to")) - Number(url.searchParams.get("from"))).toBe(60 * 60_000)
  await page.goBack()
  // Dragging: a custom range for the whole page, shown by the range control with Reset.
  box = (await chart(page, "activity").locator(".u-over").boundingBox())!
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2, { steps: 4 })
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect(page).toHaveURL(/from=\d+/)
  await expect(page.getByTestId("dash-custom-range")).toBeVisible()
  await expect.poll(() => last(state, "/tiles")?.get("from")).not.toBeNull()
  await expect.poll(() => last(state, "/breakdown")?.get("from")).not.toBeNull()
  await expect(page.getByTestId("dash-tile-turnErrors")).toContainText("vs prev. period")
  await page.getByTestId("dash-custom-range").getByRole("button", { name: "Reset" }).click()
  await expect(page).toHaveURL(/range=7d/)
  expect(new URL(page.url()).searchParams.get("from")).toBeNull()
})

test("Spend: Cost by model with the budget on daily steps, by project, Tokens by type, Show as table", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.telemetry.settings.dailyBudget = 10
  await page.goto("/operator?range=14d")
  const spend = chart(page, "spend")
  await expect(spend.locator('[data-slot="operator-chart-legend"]')).toContainText("gpt-5")
  await expect(spend.locator('[data-slot="operator-chart-legend"]')).toContainText("Other")
  await expect.poll(() => lastMetric(state, "cost")?.get("step")).toBe(String(24 * 60 * 60_000))
  expect(lastMetric(state, "cost")?.get("groupBy")).toBe("model")
  await expect(spend.getByTestId("dash-budget-note")).toHaveText("Dotted line: the daily budget, $10.00")
  // By project.
  await spend.locator('[data-component="select-v2-root"][aria-label="Cost by"] [data-component="select-v2"]').click()
  await page.locator('[data-component="menu-v2-item"]').filter({ hasText: "By project" }).click()
  await expect.poll(() => lastMetric(state, "cost")?.get("groupBy")).toBe("project")
  // Tokens by type, never one total; the "by" goes away.
  await spend.getByTestId("dash-spend-view").getByRole("button", { name: "Tokens" }).click()
  await expect.poll(() => lastMetric(state, "tokens")?.get("range")).toBe("14d")
  await expect(spend.locator('[data-slot="operator-chart-legend"]')).toContainText("Cache read")
  await expect(spend.getByTestId("dash-spend-by")).toHaveCount(0)
  await expect(spend.getByTestId("dash-budget-note")).toHaveCount(0)
  await spend.getByTestId("obs-chart-as-table").click()
  await expect(spend.locator("table tbody tr").first()).toBeVisible()
  // 24 hours: the Metrics tab's steps, no budget line.
  await spend.getByTestId("dash-spend-view").getByRole("button", { name: "Cost" }).click()
  await page.getByTestId("dash-range").getByRole("button", { name: "24 hours" }).click()
  await expect.poll(() => lastMetric(state, "cost")?.get("range")).toBe("24h")
  expect(lastMetric(state, "cost")?.get("step")).toBeNull()
  await expect(spend.getByTestId("dash-budget-note")).toHaveCount(0)
})

test("telemetry off: the charts say so", async ({ page }) => {
  const state = await mockOperator(page)
  state.telemetry.settings.enabled = false
  await page.goto("/operator")
  await expect(page.getByTestId("dash-chart-activity").getByTestId("dash-telemetry-off")).toBeVisible()
  await expect(page.getByTestId("dash-chart-spend").getByTestId("dash-telemetry-off")).toBeVisible()
  expect(state.telemetry.queries.some((query) => query.path === "/metrics")).toBe(false)
})
