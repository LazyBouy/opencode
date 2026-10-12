import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

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

test("every field has an (i) with its help, and Settings → Appearance → Field helper hides them", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/new?dir=${encodeURIComponent(directory)}`)

  // The (i) beside a field shows its help on hover; it does not change the field's name.
  const about = page.getByRole("button", { name: "About Home folder" })
  await about.hover()
  await expect(page.getByRole("tooltip")).toContainText(
    "Sessions started as this agent open in this folder, relative to the project",
  )
  await expect(page.getByLabel("Home folder", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "About Temperature" })).toBeVisible()
  await expect(page.getByRole("group", { name: "Type", exact: true })).toBeVisible()

  // Upstream's settings rows carry it too; the switch turns it off everywhere.
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await expect(settings.getByRole("button", { name: "About Color scheme" })).toBeVisible()
  await settings.locator('[data-action="settings-field-help"] [data-slot="switch-control"]').click()
  await expect(settings.getByRole("button", { name: /^About / })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(settings).toBeHidden()
  await expect(page.getByLabel("Home folder", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: /^About / })).toHaveCount(0)

  // The choice is kept.
  await page.reload()
  await expect(page.getByLabel("Home folder", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: /^About / })).toHaveCount(0)
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  await settings.locator('[data-action="settings-field-help"] [data-slot="switch-control"]').click()
  await expect(settings.getByRole("button", { name: "About Color scheme" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(settings).toBeHidden()
  await expect(page.getByRole("button", { name: "About Home folder" })).toBeVisible()
})
