import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

const directory = fixture.directory
const dir = `?dir=${encodeURIComponent(directory)}`

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory,
    project: fixture.project,
    pageMessages,
  })
})

test("a project moves to Trash after asking, and Trash restores it or deletes it for good", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/projects")
  await page.getByRole("row", { name: /smoke-project/ }).click()
  const overlay = page.getByRole("dialog").first()
  await overlay.getByRole("button", { name: "Delete", exact: true }).click()
  // The question stacks over the overlay, and says it can be restored.
  await expect(page.getByRole("heading", { name: "Move smoke-project to Trash?" })).toBeVisible()
  await expect(page.getByText("from where you can restore it")).toBeVisible()
  await page.getByRole("button", { name: "Yes, move to Trash" }).click()
  await expect.poll(() => state.trashWrites.length).toBe(1)
  expect(state.trashWrites[0]).toMatchObject({
    method: "POST",
    path: "/operator/trash/project",
    body: { key: directory },
  })

  await page.goto("/operator/deleted")
  const row = page.getByRole("row", { name: /SmokeProject/ })
  await expect(row).toContainText("Project")
  await row.click()
  await expect(page.getByRole("dialog")).toContainText(directory)
  await page.getByRole("button", { name: "Restore" }).click()
  await expect.poll(() => state.trashWrites.at(-1)?.path).toMatch(/\/operator\/trash\/trash-1\/restore$/)

  // Deleting for good warns that it cannot be undone.
  state.trash.push({ id: "trash-9", kind: "layer", name: "Reviewer", deletedAt: Date.now(), files: [] })
  await page.goto("/operator/deleted?entry=trash-9")
  await page.getByRole("button", { name: "Delete permanently" }).click()
  await expect(page.getByRole("heading", { name: "Delete Reviewer permanently?" })).toBeVisible()
  await expect(page.getByText("This cannot be undone")).toBeVisible()
  await page.getByRole("button", { name: "Cancel" }).click()
  expect(state.trashWrites.some((write) => write.method === "DELETE")).toBe(false)
  await page.getByRole("button", { name: "Delete permanently" }).click()
  await page.getByRole("button", { name: "Yes, delete permanently" }).click()
  await expect.poll(() => state.trashWrites.at(-1)).toMatchObject({ method: "DELETE", path: "/operator/trash/trash-9" })
})

test("a skill and a session move to Trash", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/capabilities${dir}&tab=skills`)
  await page
    .locator('[data-component="operator-table"]')
    .getByRole("row", { name: /release-notes/ })
    .click()
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("button", { name: "Yes, move to Trash" }).click()
  await expect.poll(() => state.trashWrites.length).toBe(1)
  expect(state.trashWrites[0]).toMatchObject({
    path: "/operator/capability/remove",
    body: { kind: "skill", name: "release-notes" },
  })
  // The record is gone from the address, so its overlay closes.
  await expect(page.getByRole("dialog")).toBeHidden()

  await page.goto("/operator/sessions")
  await page
    .locator('[data-component="operator-table"] tbody tr')
    .first()
    .getByRole("button", { name: "Delete" })
    .click()
  await page.getByRole("button", { name: "Yes, move to Trash" }).click()
  await expect.poll(() => state.trashWrites.length).toBe(2)
  expect(state.trashWrites[1]).toMatchObject({ path: "/operator/trash/session" })
})
