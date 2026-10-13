import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// A helper's triggers (agent_types_spec.md §4.9): schedules in this browser's time zone and events, edited in the
// helper's form; on its Overview each with its state and Run now; Pause all triggers in Helper settings.

test.use({ timezoneId: "Europe/Berlin" })

const dir = `?dir=${encodeURIComponent(directory)}`

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

const choose = async (page: Page, label: string, option: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

test("a new helper gets a schedule in this browser's time zone and an event trigger", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByRole("group", { name: "Type", exact: true }).getByRole("button", { name: "Helper" }).click()
  await page.getByLabel("Name", { exact: true }).fill("archiver")
  await page.getByRole("textbox", { name: "Helper text" }).fill("Archive the sessions you are given.")

  const triggers = page.getByTestId("helper-triggers")
  await expect(triggers).toContainText("None.")
  await page.getByRole("button", { name: "Add trigger" }).click()
  const first = triggers.getByTestId("helper-trigger").first()
  await expect(first.getByTestId("trigger-zone")).toHaveText("Times in Europe/Berlin.")
  await choose(page, "Trigger 1: when", "Sessions untouched for some days")
  await expect(first.getByTestId("trigger-zone")).toHaveCount(0)
  await first.getByLabel("Days without use", { exact: true }).fill("365")
  await first.getByRole("textbox", { name: "Trigger 1: what to tell it" }).fill("Archive them; say how many.")

  await page.getByRole("button", { name: "Add trigger" }).click()
  const second = triggers.getByTestId("helper-trigger").nth(1)
  await choose(page, "Trigger 2: when", "Every week")
  await choose(page, "Trigger 2: day", "Friday")
  await second.getByLabel("At", { exact: true }).fill("04:30")

  await page.getByRole("button", { name: "Create helper" }).click()
  await expect.poll(() => state.helperWrites.length).toBe(1)
  expect((state.helperWrites[0]!.body as { triggers: unknown }).triggers).toEqual([
    {
      id: "",
      on: "session.untouched",
      enabled: true,
      input: "Archive them; say how many.",
      maxPerHour: 20,
      days: 365,
    },
    { id: "", on: "weekly", enabled: true, maxPerHour: 20, tz: "Europe/Berlin", at: "04:30", day: 5 },
  ])
})

test("a helper's Overview shows its triggers' state and runs one now; Helper settings pause them all", async ({
  page,
}) => {
  const state = await mockOperator(page)
  const sorter = state.helpers.find((item) => item.name === "sorter")!
  sorter.triggers = [
    { id: "t1", on: "weekly", enabled: true, at: "04:30", day: 1, tz: "Asia/Tokyo", maxPerHour: 20 },
    { id: "t2", on: "session.turn", enabled: false, maxPerHour: 5 },
  ]
  state.triggerStates.t2 = { skipped: 3, error: "This namespace has no project to run in" }
  await page.goto(`/operator/agents${dir}&helper=sorter&hns=opencode`)

  const states = page.getByTestId("helper-trigger-states")
  const weekly = states.locator('[data-trigger="t1"]')
  await expect(weekly).toContainText("Every Monday at 04:30 (Asia/Tokyo)")
  await expect(weekly).toContainText("Next:")
  const turn = states.locator('[data-trigger="t2"]')
  await expect(turn).toContainText("An agent finished a turn")
  await expect(turn).toContainText("Off")
  await expect(turn).toContainText("Starts skipped in the last hour: 3 (at most 5 runs an hour).")
  await expect(turn.getByTestId("trigger-error")).toContainText("no project to run in")
  // Run now is for schedules (and the untouched check), not events.
  await expect(turn.getByRole("button", { name: "Run now" })).toHaveCount(0)
  await weekly.getByRole("button", { name: "Run now" }).click()
  await expect(page.getByText("Run started: see Runs")).toBeVisible()
  expect(state.helperWrites.at(-1)!.url).toContain("/operator/helper/opencode/sorter/triggers/t1/run")

  // Its run says which trigger started it.
  await page.goto(`/operator/agents${dir}&helper=sorter&hns=opencode&htab=runs`)
  await expect(page.getByRole("table", { name: "Runs" })).toContainText("Trigger · weekly (by hand)")

  // Paused: the Overview says so.
  await page.goto(`/operator/agents${dir}`)
  await page.getByRole("button", { name: "Helper settings" }).click()
  await page.getByRole("group", { name: "Pause all triggers" }).locator('[data-slot="switch-control"]').click()
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click()
  await expect.poll(() => state.helperSettings.triggersPaused).toBe(true)
  await page.goto(`/operator/agents${dir}&helper=sorter&hns=opencode`)
  await expect(page.getByTestId("triggers-paused")).toBeVisible()
})
