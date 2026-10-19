import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// observability_spec.md §8.5, §8.7, §15, §16, §21.2: saved views (a built-in applies; Save as, Rename, Delete to Trash
// and back); settings (retention saves, a wrong value says why, Rebuild shows progress, Clear goes to Trash after
// asking); export (the menu counts rows, CSV with the visible columns, past the limit it asks to narrow); telemetry off.

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

const views = async (page: Page, item: string) => {
  await page.getByTestId("obs-views-trigger").click()
  await page.getByRole("menuitem", { name: item }).click()
}

test("a built-in view applies its tab, filters and sort, never the range; Save as, Rename and Delete to Trash and back", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?range=7d")
  await views(page, "Failing tools")
  await expect(page).toHaveURL(/tab=events/)
  await expect(page).toHaveURL(/kind=tool_call/)
  await expect(page).toHaveURL(/status=error/)
  await expect(page).toHaveURL(/view=builtin-failing_tools/)
  // The range stays what it was.
  await expect(page).toHaveURL(/range=7d/)
  await expect(page.getByTestId("obs-view-current")).toHaveText("Failing tools")
  // Save as: a copy, with what the page shows and no range.
  await views(page, "Save as…")
  const name = page.getByRole("dialog").getByRole("textbox").first()
  await expect(name).toHaveValue("Failing tools (copy)")
  await name.fill("My failing tools")
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click()
  await expect
    .poll(() => state.telemetry.writes.find((write) => write.method === "POST" && write.path === "/view")?.body)
    .toMatchObject({
      name: "My failing tools",
      state: { tab: "events", params: { kind: "tool_call", status: "error", sort: "start:desc" } },
    })
  const saved = state.telemetry.writes.find((write) => write.method === "POST" && write.path === "/view")!.body as {
    state: { params: Record<string, string> }
  }
  expect(saved.state.params.range).toBeUndefined()
  await expect(page.getByTestId("obs-view-current")).toHaveText("My failing tools")
  // Rename.
  await views(page, "Rename…")
  await page.getByRole("dialog").getByRole("textbox").first().fill("Tool failures")
  await page.getByRole("dialog").getByRole("button", { name: "Rename…" }).click()
  await expect
    .poll(() => state.telemetry.writes.at(-1))
    .toMatchObject({ method: "PUT", body: { name: "Tool failures" } })
  // Delete: to Trash, after asking; restored from Trash, it is back.
  await views(page, "Delete…")
  await page.getByRole("button", { name: "Yes, move to Trash" }).click()
  await expect.poll(() => state.telemetry.writes.at(-1)?.method).toBe("DELETE")
  await page.goto("/operator/deleted")
  await page.getByText("Tool failures").click()
  await page.getByRole("button", { name: "Restore" }).click()
  await page.goto("/operator/observability")
  await page.getByTestId("obs-views-trigger").click()
  await expect(page.getByRole("menuitem", { name: "Tool failures" })).toBeVisible()
})

test("settings: retention saves, a wrong value says why, Rebuild shows progress, Clear goes to Trash after asking", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability")
  await page.getByRole("button", { name: "More actions" }).click()
  await page.getByTestId("obs-open-settings").click()
  const settings = page.getByTestId("obs-settings")
  await expect(settings).toBeVisible()
  const events = settings.getByRole("spinbutton", { name: "Keep detailed events for (days)" })
  await expect(events).toHaveValue("30")
  await events.fill("0")
  await settings.getByTestId("obs-settings-save").click()
  await expect(settings.getByRole("alert")).toContainText("1 to 365")
  await events.fill("14")
  await settings.getByText("Call recording", { exact: true }).click()
  await settings.getByTestId("obs-settings-save").click()
  await expect(settings.getByTestId("obs-settings-note")).toContainText("once no session is running")
  expect(state.telemetry.writes.findLast((write) => write.path === "/settings")?.body).toMatchObject({
    eventsDays: 14,
    recordCalls: false,
  })
  // Rebuild from history, with its progress.
  state.telemetry.backfill = { state: "running", done: 10, total: 64 }
  await settings.getByTestId("obs-settings-rebuild").click()
  await expect(settings.getByTestId("obs-settings-progress")).toBeVisible()
  // Clear: asks, then the store is in Trash.
  await settings.getByTestId("obs-settings-clear").click()
  await page.getByRole("button", { name: "Yes, move it to Trash" }).click()
  await expect(settings.getByTestId("obs-settings-note")).toContainText("Telemetry cleared")
  await page.goto("/operator/deleted")
  await expect(page.getByText("Telemetry store").first()).toBeVisible()
})

test("export: the menu counts the rows, CSV has the visible columns; past the limit it asks to narrow", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=events")
  await expect(page.getByTestId("obs-event-row").first()).toBeVisible()
  await page.getByTestId("obs-export").click()
  await expect(page.getByTestId("obs-export-count")).toContainText("42 rows")
  const download = page.waitForEvent("download")
  await page.getByRole("menuitem", { name: "CSV (the visible columns)" }).click()
  expect((await download).suggestedFilename()).toMatch(/^opencode-events-\d{12}-\d{12}\.csv$/)
  const asked = state.telemetry.writes.findLast((write) => write.path === "/export")!.params!
  expect(asked.get("tab")).toBe("events")
  expect(asked.get("format")).toBe("csv")
  expect(asked.get("cols")?.split(",").slice(0, 3)).toEqual(["start", "kind", "name"])
  expect(asked.get("tz")).toMatch(/^-?\d+$/)
  // Past 100,000 rows: it says how many and asks to narrow.
  state.telemetry.exportRows = 150_000
  await page.keyboard.press("Escape")
  await page.getByTestId("obs-export").click()
  await expect(page.getByTestId("obs-export-count")).toContainText("150,000 rows match")
  await expect(page.getByRole("menuitem", { name: "CSV (the visible columns)" })).toBeDisabled()
})

test("telemetry off: the empty state says so and opens the settings", async ({ page }) => {
  const state = await mockOperator(page)
  state.telemetry.settings.enabled = false
  // Nothing of this kind recorded: the tab is empty, and says why.
  await page.goto("/operator/observability?tab=events&kind=alert")
  await expect(page.getByText("Telemetry is off")).toBeVisible()
  await page.getByRole("button", { name: "Turn on in Observability settings" }).click()
  await expect(page.getByTestId("obs-settings")).toBeVisible()
})

test("+ Filter adds a filter without a facet: a value asked for, or a flag at once; each shows as a chip", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=events")
  await page.getByTestId("obs-add-filter").click()
  await page.getByRole("menuitem", { name: "Cost at least" }).click()
  await page.getByRole("dialog").getByRole("textbox").fill("0.5")
  await page.getByRole("dialog").getByRole("button", { name: "Add filter" }).click()
  await expect(page).toHaveURL(/minCost=0\.5/)
  await expect(page.getByTestId("obs-chip").filter({ hasText: "0.5" })).toBeVisible()
  await expect
    .poll(() => state.telemetry.queries.findLast((query) => query.path === "/events")?.params.get("minCost"))
    .toBe("0.5")
  await page.getByTestId("obs-add-filter").click()
  await page.getByRole("menuitem", { name: "Possible loops" }).click()
  await expect(page).toHaveURL(/loop=1/)
})
