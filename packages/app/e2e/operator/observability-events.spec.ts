import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator, now } from "./mock-operator"

// observability_spec.md §8.6, §11, §13, §21.2: the Events tab's kind chips and span overlay; live tail adds rows and
// updates a running one in place, and pauses when scrolled away ("N new events"); the Logs tab's levels, fields and
// note; Show in Events from a span.

const pending: unknown[] = []
const written = () => pending.push({ payload: { type: "operator.telemetry.written", properties: { seq: 1 } } })

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

const last = (state: Awaited<ReturnType<typeof mockOperator>>, path: string) =>
  state.telemetry.queries.findLast((query) => query.path === path)?.params

test("Events: kind chips narrow the stream; a row opens its span, and Open session goes to it", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=events")
  const rows = page.getByTestId("obs-event-row")
  await expect(rows.first()).toBeVisible()
  await page.getByTestId("obs-kind-chip").filter({ hasText: "Tools" }).click()
  await expect.poll(() => last(state, "/events")?.get("kind")).toBe("tool_call")
  await expect(rows).toHaveCount(2)
  // The session column names the session.
  await expect(rows.filter({ hasText: "execute_tool bash" })).toContainText("Fix the failing test")
  await rows.filter({ hasText: "execute_tool bash" }).click()
  await expect(page).toHaveURL(/ev=tool%3Abash/)
  await page.getByRole("button", { name: "Open session" }).click()
  const detail = page.getByTestId("obs-session-detail")
  await expect(detail.getByTestId("obs-span-panel")).toContainText("execute_tool bash")
  await expect(page).toHaveURL(/span=tool%3Abash/)
})

test("Live: written rows come on top, a running row updates in place, scrolled away it waits", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=events&live=1")
  const rows = page.getByTestId("obs-event-row")
  await expect(rows.first()).toBeVisible()
  const before = await rows.count()
  state.telemetry.write({
    id: "tool:grep",
    kind: "tool_call",
    name: "execute_tool grep",
    tool: "grep",
    session_id: "ses_main",
    start_ms: now,
    status: "running",
    source: "part",
  })
  written()
  await expect(rows.first()).toContainText("execute_tool grep")
  await expect(rows.first()).toHaveAttribute("data-status", "running")
  await expect(rows).toHaveCount(before + 1)
  // The running call completes: the same row, updated.
  state.telemetry.write({ id: "tool:grep", status: "ok", end_ms: now + 2000, duration_ms: 2000, active_ms: 2000 })
  written()
  await expect(rows.first()).toHaveAttribute("data-status", "ok")
  await expect(rows).toHaveCount(before + 1)
  // Scrolled away from the newest row: it waits and says how many came.
  await page.locator('[data-component="operator-obs-events"] [data-slot="operator-obs-scroll"]').evaluate((element) => {
    element.scrollTop = 400
    element.dispatchEvent(new Event("scroll"))
  })
  state.telemetry.write({
    id: "tool:glob",
    kind: "tool_call",
    name: "execute_tool glob",
    session_id: "ses_main",
    start_ms: now + 10,
    status: "ok",
    source: "part",
  })
  written()
  const waiting = page.getByTestId("obs-new-events")
  await expect(waiting).toContainText("1 new events")
  await waiting.click()
  await expect(rows.first()).toContainText("execute_tool glob")
})

test("Logs: the lowest level, a line's fields and Copy line; the note says what is kept and where", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=logs")
  const rows = page.getByTestId("obs-log-row")
  await expect(rows).toHaveCount(2)
  await expect(page.getByTestId("obs-logs-note")).toContainText("warnings and errors")
  await expect(page.getByTestId("obs-logs-note")).toContainText("/root/.local/share/opencode/log/opencode.log")
  await expect(rows.first()).toContainText("Error")
  await rows.filter({ hasText: "stream error" }).click()
  await expect(page.getByText("error.message", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Copy line" })).toBeVisible()
  await page
    .locator('[data-component="select-v2-root"][aria-label="Lowest level"] [data-component="select-v2"]')
    .click()
  await page.locator('[data-component="menu-v2-item"]').filter({ hasText: "Errors only" }).click()
  await expect.poll(() => last(state, "/logs")?.get("level")).toBe("error")
  await expect(rows).toHaveCount(1)
})

test("Show in Events: the Events tab, filtered to the span's session over its turn's time", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(
    `/operator/observability?session=ses_main&turn=${encodeURIComponent("turn:msg_u22")}&span=${encodeURIComponent("tool:bash")}`,
  )
  const panel = page.getByTestId("obs-span-panel")
  await expect(panel).toContainText("execute_tool bash")
  await panel.getByRole("button", { name: "Show in Events" }).click()
  await expect(page).toHaveURL(/tab=events/)
  await expect(page).toHaveURL(/inSession=ses_main/)
  await expect(page).not.toHaveURL(/[?&]session=/)
  await expect.poll(() => last(state, "/events")?.get("session")).toBe("ses_main")
  expect(Number(last(state, "/events")?.get("from"))).toBeGreaterThan(0)
  await expect(page.getByTestId("obs-event-row").first()).toBeVisible()
})
