import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// observability_spec.md §8–§10, §21.2: deep links restore the view and open the session detail at a turn and span;
// the Sessions tab sorts and pages on the server, adds optional columns and subagent sessions; the session detail
// pages back through turns, shows hatched waits, numbered attempts and an expandable subagent, works from the
// keyboard, and links from the span panel to the Transcript and the decision record.

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

const last = (state: Awaited<ReturnType<typeof mockOperator>>, path: string) =>
  state.telemetry.queries.findLast((query) => query.path === path)?.params

test("a link restores the sort and opens the session detail at its turn and span", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(
    `/operator/observability?sort=cost:desc&session=ses_main&turn=${encodeURIComponent("turn:msg_u22")}&span=${encodeURIComponent("perm:per_1")}`,
  )
  await expect.poll(() => last(state, "/sessions")?.get("sort")).toBe("cost:desc")
  const detail = page.getByTestId("obs-session-detail")
  await expect(detail).toContainText("Fix the failing test")
  // The turn in the link is open, and the span panel shows the wait.
  await expect(detail.getByTestId("obs-timeline")).toBeVisible()
  const panel = detail.getByTestId("obs-span-panel")
  await expect(panel).toContainText("approval bash (git push*)")
  await expect(panel).toContainText("git push*")
  await expect(panel).toContainText("A person")
  // Another span replaces it in the address; Back returns to the wait.
  await detail.getByTestId("obs-timeline-row").filter({ hasText: "execute_tool bash" }).click()
  await expect(page).toHaveURL(/span=tool%3Abash/)
  await expect(panel).toContainText("execute_tool bash")
  await page.goBack()
  await expect(page).toHaveURL(/span=perm%3Aper_1/)
})

test("the Sessions tab sorts and pages on the server, with optional columns and subagent sessions", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability")
  const rows = page.getByTestId("obs-session-row")
  await expect(rows.first()).toBeVisible()
  // Statuses are an icon and a word.
  const main = rows.filter({ hasText: "Fix the failing test" })
  await expect(main.locator('[data-slot="operator-obs-status"][data-status="error"]')).toContainText("Error")
  await expect(main.locator('[data-slot="operator-obs-status"] svg')).toHaveCount(1)
  // 61 top sessions: 50, then Load more.
  await expect(rows).toHaveCount(50)
  await expect(page.getByText("1–50 of 61")).toBeVisible()
  await page.getByRole("button", { name: "Load more" }).click()
  await expect(rows).toHaveCount(61)
  // The server sorts.
  await page.getByRole("button", { name: "Cost", exact: true }).click()
  await expect.poll(() => last(state, "/sessions")?.get("sort")).toBe("cost:asc")
  await expect(rows.first()).toContainText("Session 0")
  // An optional column.
  await page
    .getByRole("button", { name: /optional columns|Columns/i })
    .first()
    .click()
  await page.getByRole("menuitemcheckbox", { name: "Model", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("columnheader", { name: /Model/ })).toBeVisible()
  // Subagent sessions, each under its parent when sorted by start.
  // Newest first by start: the parent and its child on the first page.
  await page.getByRole("button", { name: "Started", exact: true }).click()
  await page.getByRole("button", { name: "Started", exact: true }).click()
  await expect.poll(() => last(state, "/sessions")?.get("sort")).toBe("started:desc")
  await page.getByText("Include subagent sessions", { exact: true }).click()
  await expect.poll(() => last(state, "/sessions")?.get("roots")).toBe("0")
  const ids = await page
    .getByTestId("obs-session-row")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-session")))
  expect(ids.indexOf("ses_child")).toBe(ids.indexOf("ses_main") + 1)
})

test("the session detail: earlier turns, hatched waits, numbered attempts, a subagent, the keyboard and links", async ({
  page,
}) => {
  const state = await mockOperator(page)
  ;(state as unknown as { decisions: unknown[] }).decisions.push({
    requestID: "per_1",
    sessionID: "ses_main",
    directory: "/workspace/opencode",
    permission: "bash",
    patterns: ["git push*"],
    metadata: {},
    askedAt: Date.now() - 60_000,
    decidedAt: Date.now() - 30_000,
    decision: "allow",
    who: "me",
    via: "inbox",
  })
  await page.goto("/operator/observability?session=ses_main")
  const detail = page.getByTestId("obs-session-detail")
  const turns = detail.getByTestId("obs-turn")
  await expect(turns).toHaveCount(20)
  await expect(turns.first()).toContainText("Turn 3")
  await detail.getByRole("button", { name: "Show earlier turns" }).click()
  await expect(turns).toHaveCount(22)
  await expect(turns.first()).toContainText("Turn 1")
  // The last turn: its prompt's first line, and its timeline.
  const latest = turns.filter({ hasText: "Turn 22" })
  await expect(latest).toContainText("“Now run the whole suite”")
  await latest.locator('[data-slot="operator-obs-turn-head"]').click()
  const timeline = latest.getByTestId("obs-timeline")
  // The wait is hatched and says who it waited for; the retried call is numbered.
  await expect(timeline.locator('[data-slot="operator-obs-bar"][data-hatched]')).toHaveCount(1)
  await expect(timeline.getByTestId("obs-timeline-row").filter({ hasText: "approval bash" })).toContainText(
    "waited for me",
  )
  await expect(timeline.getByTestId("obs-timeline-row").filter({ hasText: "#2 retry" })).toHaveCount(1)
  await expect(timeline.getByTestId("obs-timeline-row").filter({ hasText: "✗ http_429" })).toHaveCount(1)
  // The subagent is collapsed; expanding it shows its session's turns.
  const subagent = timeline.getByTestId("obs-timeline-row").filter({ hasText: "invoke_agent explore" })
  await expect(subagent).toHaveAttribute("aria-expanded", "false")
  await subagent.getByRole("button", { name: "Expand" }).click()
  await expect(timeline.getByText("Look for the test file")).toBeVisible()
  // The keyboard: the first row, down, Enter opens the span panel.
  await timeline.getByTestId("obs-timeline-row").first().focus()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  const panel = detail.getByTestId("obs-span-panel")
  await expect(panel).toContainText("chat claude-sonnet-4-5")
  await expect(page).toHaveURL(/span=call%3Ac1/)
  // The wait's decision record.
  await timeline.getByTestId("obs-timeline-row").filter({ hasText: "approval bash" }).click()
  await panel.getByRole("button", { name: "Decision record" }).click()
  await expect(page.getByTestId("decision-fields")).toBeVisible()
  await page.keyboard.press("Escape")
  // The model call in the Transcript.
  await timeline.getByTestId("obs-timeline-row").filter({ hasText: "#1" }).first().click()
  await panel.getByRole("button", { name: "Open in Transcript" }).click()
  await expect(page).toHaveURL(/view=transcript.*call=c1|call=c1.*view=transcript/)
})

test("empty: no match says so and offers to clear the filters", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/observability?q=nothing-matches-this")
  await expect(page.getByText(/No sessions match these filters/)).toBeVisible()
  await page.getByRole("button", { name: "Clear filters" }).click()
  await expect(page.getByTestId("obs-session-row").first()).toBeVisible()
})
