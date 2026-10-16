import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// observability_spec.md §12, §17, §18, §21.2: every chart renders and has "Show as table" with CSV; clicking a point
// opens Events with that step's and series' filters; dragging zooms the page's range (Reset zoom undoes it); the "≈"
// note past the detailed window; Group by with Other's values; Compare; the keyboard moves the cursor and opens a step.

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
})

const last = (state: Awaited<ReturnType<typeof mockOperator>>, metric: string) =>
  state.telemetry.queries.findLast((query) => query.path === "/metrics" && query.params.get("metric") === metric)
    ?.params
const chart = (page: Page, metric: string) => page.locator(`[data-testid="obs-chart"][data-metric="${metric}"]`)
const plot = async (page: Page, metric: string) => {
  const over = chart(page, metric).locator(".u-over")
  await expect(over).toBeVisible()
  return (await over.boundingBox())!
}

test("every chart renders, with Show as table and CSV; tables and notes where a chart has no series", async ({
  page,
}) => {
  await mockOperator(page)
  await page.goto("/operator/observability?tab=metrics")
  const charts = page.getByTestId("obs-chart")
  await expect(charts).toHaveCount(38)
  for (const frame of await charts.all()) {
    await frame.scrollIntoViewIfNeeded()
    await expect(frame).not.toContainText(/Loading/)
    const metric = await frame.getAttribute("data-metric")
    if (metric === "tool_table" || metric === "approval_table") continue
    if (await frame.getByTestId("obs-chart-empty").count()) continue
    await expect(frame.getByTestId("obs-chart-as-table"), `${metric} has Show as table`).toBeVisible()
  }
  const calls = chart(page, "calls")
  await calls.scrollIntoViewIfNeeded()
  await expect(calls.locator("canvas").first()).toBeVisible()
  await expect(calls.getByTestId("obs-chart-source")).toHaveText("From events")
  await calls.getByTestId("obs-chart-as-table").click()
  await expect(calls.locator("table tbody tr").first()).toBeVisible()
  const download = page.waitForEvent("download")
  await calls.getByTestId("obs-chart-csv").click()
  expect((await download).suggestedFilename()).toBe("calls.csv")
  // Time to first token needs call recording; the tool table groups MCP tools under their server.
  await expect(chart(page, "ttft")).toContainText("Turn on call recording")
  await expect(page.getByTestId("obs-tool-row")).toHaveCount(2)
  await expect(chart(page, "tool_table")).toContainText("github (MCP)")
  // The per-turn histogram's bars name their bucket and count.
  await expect(chart(page, "calls_per_turn").getByRole("img", { name: "2, Turns: 5 turns" })).toBeVisible()
})

test("clicking a point opens Events filtered to that step and series", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=metrics")
  const box = await plot(page, "turns")
  // The bottom of the stack is the first series: OK turns.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 3)
  await expect(page).toHaveURL(/tab=events/)
  await expect(page).toHaveURL(/kind=turn/)
  await expect(page).toHaveURL(/status=ok/)
  const url = new URL(page.url())
  // A 24 h range steps by 15 minutes.
  expect(Number(url.searchParams.get("to")) - Number(url.searchParams.get("from"))).toBe(15 * 60_000)
  await expect
    .poll(() => state.telemetry.queries.findLast((query) => query.path === "/events")?.params.get("kind"))
    .toBe("turn")
})

test("dragging zooms the page's range; Reset zoom goes back", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/observability?tab=metrics&range=24h")
  const box = await plot(page, "turns")
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2, { steps: 4 })
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect(page).toHaveURL(/from=\d+/)
  await expect(page).toHaveURL(/tab=metrics/)
  expect(new URL(page.url()).searchParams.get("range")).toBeNull()
  await page.getByRole("button", { name: "Reset zoom" }).click()
  await expect(page).toHaveURL(/range=24h/)
  expect(new URL(page.url()).searchParams.get("from")).toBeNull()
})

test("past the detailed window the source note says hourly totals (≈)", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=metrics&range=90d")
  await chart(page, "calls").scrollIntoViewIfNeeded()
  await expect(chart(page, "calls").getByTestId("obs-chart-source")).toContainText("From hourly totals (≈")
  await expect(page.getByTestId("obs-beyond")).toBeVisible()
  await expect.poll(() => last(state, "calls")?.get("range")).toBe("90d")
})

test("Group by splits a section's charts into the top values and Other, whose values can be listed", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=metrics")
  const section = page.locator("#obs-section-calls")
  await section.scrollIntoViewIfNeeded()
  await section.locator('[data-component="select-v2-root"][aria-label="Group by"] [data-component="select-v2"]').click()
  await page.locator('[data-component="menu-v2-item"]').filter({ hasText: "By model" }).click()
  await expect(page).toHaveURL(/by=calls%3Amodel/)
  await expect.poll(() => last(state, "calls")?.get("groupBy")).toBe("model")
  const calls = chart(page, "calls")
  await expect(calls.locator('[data-slot="operator-chart-legend"]')).toContainText("gpt-5")
  await expect(calls.locator('[data-slot="operator-chart-legend"]')).toContainText("Other")
  await calls.getByRole("button", { name: "2 values" }).click()
  await expect(calls).toContainText("gemini-2.5-pro, grok-4")
  // A total opens Events for that value over the range.
  await calls.locator('[data-component="operator-bar-list"]').getByRole("button", { name: "gpt-5" }).click()
  await expect(page).toHaveURL(/tab=events/)
  await expect(page).toHaveURL(/model=gpt-5/)
})

test("Compare adds the previous period; the keyboard moves the cursor and Enter opens the step", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=metrics")
  const section = page.locator("#obs-section-turns")
  await section.getByText("Compare", { exact: true }).click()
  await expect(page).toHaveURL(/compare=turns/)
  await expect(chart(page, "turns").locator('[data-slot="operator-chart-legend"]')).toContainText("Previous period")
  // The previous period is asked for on the same step.
  await expect
    .poll(() =>
      state.telemetry.queries.some(
        (query) => query.path === "/metrics" && query.params.get("metric") === "turns" && query.params.get("step"),
      ),
    )
    .toBe(true)
  const focused = chart(page, "turns").locator('[data-slot="operator-chart-plot"]')
  await focused.focus()
  await page.keyboard.press("ArrowRight")
  await expect(chart(page, "turns").locator('[role="status"]')).toContainText("OK")
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/tab=events/)
  await expect(page).toHaveURL(/kind=turn/)
})
