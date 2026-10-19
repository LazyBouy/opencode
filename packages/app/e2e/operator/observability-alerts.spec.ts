import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// observability_spec.md §14, §21.2: a seeded rule fires; it shows on the tab badge and the nav item, in Firing now, in
// History and in the Inbox; Acknowledge clears the badge; Mute and Unmute; View events opens the rule's filter; a row opens its editor,
// a new rule is created from the form; deleting a user rule puts it in Trash; a built-in rule resets but can't be
// deleted.

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

const pick = async (page: Page, scope: ReturnType<Page["locator"]>, label: string, option: string) => {
  await scope.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page.locator('[data-component="menu-v2-item"]').filter({ hasText: option }).first().click()
}

test("a firing alert: the tab badge, Firing now, History and the Inbox; Acknowledge clears the badge", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=alerts")
  await expect(page.getByTestId("obs-alerts-badge")).toHaveText("1")
  // The Observability nav item shows the same count.
  await expect(
    page.locator('[data-slot="operator-sidebar-item"][data-page="observability"]').getByTestId("operator-nav-badge"),
  ).toHaveText("1")
  const card = page.getByTestId("obs-alert-firing")
  await expect(card).toHaveCount(1)
  await expect(card).toContainText("Too many denials")
  await expect(card).toContainText("Critical")
  await expect(card).toContainText("4 now, against ≥ 3")
  await expect(card).toContainText("Agent: build")
  await expect(page.getByTestId("obs-alert-event")).toHaveCount(2)
  // The rules table says each condition in words.
  await expect(page.getByTestId("obs-alert-rule").filter({ hasText: "Model calls failing" })).toContainText(
    "Model call error rate > 20% over 15 min, at least 10 calls",
  )
  await expect(page.getByTestId("obs-alert-rule").filter({ hasText: "Daily cost" })).toContainText("Off")
  // The Inbox lists it under Alerts.
  await page.goto("/operator/inbox?itab=alerts")
  await expect(page.getByText("Alerts (1)")).toBeVisible()
  const inbox = page.getByTestId("inbox-alerts")
  await expect(inbox.getByTestId("obs-alert-firing")).toContainText("Too many denials")
  await inbox.getByRole("button", { name: "Acknowledge" }).click()
  await expect.poll(() => state.telemetry.alertWrites.at(-1)?.path).toBe("/alert/event/alert-1/ack")
  await expect(inbox).toContainText("Acknowledged by operator")
  await expect(page.getByText("Alerts (0)")).toBeVisible()
  await page.goto("/operator/observability?tab=alerts")
  await expect(page.getByTestId("obs-alert-firing")).toContainText("Acknowledged by operator")
  await expect(page.getByTestId("obs-alerts-badge")).toHaveCount(0)
  await expect(page.getByTestId("operator-nav-badge")).toHaveCount(0)
})

test("Mute takes a rule's alert off the badge; Unmute brings it back; View events opens its filter", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=alerts")
  const card = page.getByTestId("obs-alert-firing")
  await pick(page, card, "Mute…", "Mute for 1 hour")
  await expect
    .poll(() => state.telemetry.alertWrites.at(-1))
    .toMatchObject({
      path: "/alert/rule/rule-denials/mute",
      body: { for: "1h" },
    })
  await expect(page.getByTestId("obs-alerts-badge")).toHaveCount(0)
  await expect(card).toContainText("Muted")
  await card.getByRole("button", { name: "Unmute" }).click()
  await expect(page.getByTestId("obs-alerts-badge")).toHaveText("1")
  await card.getByRole("button", { name: "View events" }).click()
  await expect(page).toHaveURL(/tab=events/)
  await expect(page).toHaveURL(/kind=tool_call/)
  await expect(page).toHaveURL(/status=denied/)
  await expect(page).toHaveURL(/agent=build/)
  await expect(page).toHaveURL(/from=\d+/)
})

test("a new rule from the form: its condition in words, saved", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=alerts")
  await page.getByTestId("obs-alert-new").click()
  const form = page.getByTestId("obs-alert-form")
  await expect(form).toBeVisible()
  await form.getByLabel("Name", { exact: true }).fill("Bursts of 429s")
  // Thirteen metrics: the long-list picker, with search. Its list opens outside the overlay, which the modal hides
  // from the accessibility tree (includeHidden); pointer and keyboard reach it.
  await form
    .locator('[data-component="operator-list-picker"][aria-label="Metric"] [data-slot="list-picker-trigger"]')
    .click()
  const list = page.locator('[data-component="operator-list-picker-content"]')
  await list.locator("input").fill("Rate limits")
  await list.getByRole("option", { name: "Rate limits (HTTP 429)", includeHidden: true }).click()
  await form.getByRole("spinbutton", { name: "Threshold (count)" }).fill("2")
  await expect(page.getByTestId("obs-alert-preview")).toHaveText("Fires when: Rate limits (HTTP 429) > 2 over 15 min.")
  await page.getByTestId("obs-alert-save").click()
  await expect
    .poll(
      () => state.telemetry.alertWrites.find((write) => write.method === "POST" && write.path === "/alert/rule")?.body,
    )
    .toMatchObject({
      name: "Bursts of 429s",
      metric: "rate_limits",
      op: ">",
      threshold: 2,
      window: "15",
      enabled: true,
    })
  await expect(page.getByTestId("obs-alert-rule").filter({ hasText: "Bursts of 429s" })).toBeVisible()
})

test("a user rule is deleted to Trash; a built-in rule resets but can't be deleted", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/observability?tab=alerts")
  await page.getByTestId("obs-alert-rule").filter({ hasText: "Rate limited" }).click()
  const editor = page.getByTestId("obs-alert-editor")
  await expect(editor.getByRole("button", { name: "Reset to defaults" })).toBeVisible()
  await expect(editor.getByTestId("obs-alert-delete")).toHaveCount(0)
  await editor.getByRole("button", { name: "Cancel" }).click()
  await expect(editor).toHaveCount(0)
  await page.getByTestId("obs-alert-rule").filter({ hasText: "Too many denials" }).click()
  await expect(page).toHaveURL(/rule=rule-denials/)
  await page.getByTestId("obs-alert-delete").click()
  await page.getByRole("button", { name: "Yes, move to Trash" }).click()
  await expect
    .poll(() => state.telemetry.alertWrites.at(-1))
    .toMatchObject({
      method: "DELETE",
      path: "/alert/rule/rule-denials",
    })
  await expect(page.getByTestId("obs-alert-editor")).toHaveCount(0)
  await expect(page.getByTestId("obs-alert-rule").filter({ hasText: "Too many denials" })).toHaveCount(0)
  await page.goto("/operator/deleted")
  await expect(page.getByText("Too many denials")).toBeVisible()
  await expect(page.getByText("Alert rule").first()).toBeVisible()
})
