import { expect, type Page, test } from "@playwright/test"
import { mockOperator } from "./mock-operator"

// Every overlay box can be resized (the user, 2026-10-11): handles on its edges (horizontal, vertical) and corners
// (diagonal); dragging one doesn't close the overlay.

const drag = async (page: Page, handle: ReturnType<Page["locator"]>, dx: number, dy: number) => {
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y + dy / 2)
  await page.mouse.move(x + dx, y + dy)
  await page.mouse.up()
}

test("a record overlay resizes from a corner, an edge and the other side, and stays open", async ({ page }) => {
  await mockOperator(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/operator/models?ns=opencode&model=${encodeURIComponent("opencode/claude-opus-4-6")}`)
  const container = page.locator('[data-slot="dialog-container"][data-resizable]').last()
  await expect(container.locator("[data-resize-handle]")).toHaveCount(8)
  const before = (await container.boundingBox())!

  // Diagonal: the bottom-right corner.
  await drag(page, container.locator('[data-resize-handle="se"]'), -80, -60)
  let after = (await container.boundingBox())!
  expect(Math.round(after.width)).toBe(Math.round(before.width - 80))
  expect(Math.round(after.height)).toBe(Math.round(before.height - 60))
  expect(Math.round(after.x)).toBe(Math.round(before.x))

  // Horizontal: the left edge moves, the right one stays.
  const right = after.x + after.width
  await drag(page, container.locator('[data-resize-handle="w"]'), -50, 0)
  after = (await container.boundingBox())!
  expect(Math.round(after.x + after.width)).toBe(Math.round(right))
  expect(Math.round(after.width)).toBe(Math.round(before.width - 80 + 50))

  // Vertical: the bottom edge.
  const height = after.height
  await drag(page, container.locator('[data-resize-handle="s"]'), 0, 40)
  after = (await container.boundingBox())!
  expect(Math.round(after.height)).toBe(Math.round(height + 40))

  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page).toHaveURL(/model=/)
})

test("questions and Settings resize too", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator('[data-slot="dialog-container"][data-resizable]').last()
  await expect(settings.locator("[data-resize-handle]")).toHaveCount(8)
  const before = (await settings.boundingBox())!
  await drag(page, settings.locator('[data-resize-handle="e"]'), -100, 0)
  const after = (await settings.boundingBox())!
  expect(Math.round(after.width)).toBe(Math.round(before.width - 100))
  await expect(page.locator(".settings-v2-dialog")).toBeVisible()
})
