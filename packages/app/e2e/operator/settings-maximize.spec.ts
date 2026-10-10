import { expect, test, type Page } from "@playwright/test"
import { mockOperator } from "./mock-operator"

// Settings' Maximize (operator/settings/settings-maximize.tsx): the dialog fills the window below the title
// bar, Restore puts it back, and the choice is remembered in this browser.

const openSettings = async (page: Page) => {
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await expect(settings).toBeVisible()
  return settings
}
const container = (page: Page) => page.locator('[data-slot="dialog-container"]:has(.settings-v2-dialog)')

test("Settings maximizes to the window, restores, and remembers the choice", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator")
  const settings = await openSettings(page)
  const before = await container(page).boundingBox()
  await settings.getByRole("button", { name: "Maximize" }).click()
  await expect(container(page)).toHaveAttribute("data-operator-maximized", "")
  const viewport = page.viewportSize()!
  await expect
    .poll(async () => (await container(page).boundingBox())?.width ?? 0)
    .toBeGreaterThan(Math.max(before?.width ?? 0, viewport.width - 4))

  // Closed and opened again: still maximized.
  await page.keyboard.press("Escape")
  await expect(settings).toBeHidden()
  const again = await openSettings(page)
  await expect(container(page)).toHaveAttribute("data-operator-maximized", "")

  await again.getByRole("button", { name: "Restore" }).click()
  await expect(container(page)).not.toHaveAttribute("data-operator-maximized", "")
  await expect.poll(async () => (await container(page).boundingBox())?.width ?? 0).toBeLessThan(viewport.width - 4)
})
