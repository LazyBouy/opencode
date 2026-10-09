import { expect, type Page, test } from "@playwright/test"
import { mockOperator } from "./mock-operator"

// Iteration 5 fixes, phase 2 (fixes_spec.md §1, §2): every overlay has Full screen, which keeps its
// menu and adds the back path; Back and Close return to the page the overlay was opened on; Esc leaves
// full screen first and asks before an edit is lost; an open project shows its own sections, Config
// among them.

const projectRow = (page: Page) => page.getByRole("row", { name: /smoke-project/ })

// Dashboard → Projects → smoke-project, as a user gets there.
async function openProject(page: Page) {
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("link", { name: "Projects" }).click()
  await expect(page).toHaveURL(/\/operator\/projects$/)
  await projectRow(page).click()
  const overlay = page.getByRole("dialog")
  await expect(overlay.getByRole("tab", { name: "Overview" })).toBeVisible()
  return overlay
}

test("full screen keeps the record's menu, shows how you got there, and survives a reload", async ({ page }) => {
  await mockOperator(page)
  const overlay = await openProject(page)
  await overlay.getByRole("button", { name: "Full screen" }).click()
  await expect(page).toHaveURL(/full=1/)
  const top = page.getByTestId("overlay-topbar")
  await expect(top.getByTestId("overlay-trail")).toContainText("Dashboard › Projects › smoke-project")
  // The record's menu replaces the sidebar: the frame starts at the window's left edge.
  const frame = (await page.getByTestId("overlay-frame").boundingBox())!
  expect(frame.x).toBeLessThanOrEqual(1)
  await expect(overlay.getByRole("tab", { name: "Config" })).toBeVisible()

  await page.reload()
  await expect(page.getByTestId("overlay-topbar")).toBeVisible()
  await expect(page.getByTestId("overlay-trail")).toContainText("Dashboard › Projects › smoke-project")

  // Esc leaves full screen, back to the overlay; Exit full screen does the same.
  await page.keyboard.press("Escape")
  await expect(page).not.toHaveURL(/full=1/)
  await expect(page.getByRole("dialog").getByRole("tab", { name: "Overview" })).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "Full screen" }).click()
  await page.getByRole("button", { name: "Exit full screen" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  // Close at once, with leaving full screen still on its way: back to Projects.
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(page).toHaveURL(/\/operator\/projects$/)
})

test("‹ Back and the browser's Back go to Projects, then the Dashboard", async ({ page }) => {
  await mockOperator(page)
  const overlay = await openProject(page)
  await overlay.getByRole("button", { name: "Full screen" }).click()
  await page.getByTestId("overlay-topbar").getByRole("button", { name: "Back" }).click()
  await expect(page).toHaveURL(/\/operator\/projects$/)
  await expect(page.getByRole("dialog")).toBeHidden()
  await page.goBack()
  await expect(page).toHaveURL(/\/operator$/)

  // The browser's Back closes an overlay.
  await page.goForward()
  await projectRow(page).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(page).toHaveURL(/\/operator\/projects$/)

  // Close returns to the page it was opened on: Back from there is the Dashboard, not the overlay.
  await projectRow(page).click()
  await page.getByRole("dialog").getByRole("tab", { name: "Sessions" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(page).toHaveURL(/\/operator\/projects$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/operator$/)
})

test("Esc asks before an edit is lost", async ({ page }) => {
  await mockOperator(page)
  const overlay = await openProject(page)
  await overlay.getByRole("button", { name: "Edit project", exact: true }).click()
  // Typing in the form, then Esc.
  await overlay.locator("textarea, input").first().focus()
  await page.keyboard.press("Escape")
  const question = page.getByTestId("overlay-question")
  await expect(question).toContainText("Discard your changes?")
  await question.getByRole("button", { name: "Cancel" }).click()
  await expect(question).toBeHidden()
  await expect(overlay.getByRole("button", { name: "Save", exact: true })).toBeVisible()
  await overlay.locator("textarea, input").first().focus()
  await page.keyboard.press("Escape")
  await page.getByTestId("overlay-question").getByRole("button", { name: "Discard" }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(page).toHaveURL(/\/operator\/projects$/)
})

test("an open project has its own sections; Config edits its files inside the record", async ({ page }) => {
  const state = await mockOperator(page)
  const overlay = await openProject(page)
  await expect(overlay.getByRole("button", { name: "All projects" })).toBeVisible()

  await overlay.getByRole("tab", { name: "Config" }).click()
  await expect(page).toHaveURL(/psec=config/)
  const editor = overlay.getByRole("textbox", { name: "Edit settings" })
  await expect(editor).toHaveValue(/"username": "me"/)
  await editor.fill('{ "username": "you" }')
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.writes.filter((write) => write.url.includes("/operator/config/project")).length).toBe(1)
  const write = state.writes.find((item) => item.url.includes("/operator/config/project"))!
  expect(write.body).toMatchObject({ text: '{ "username": "you" }' })

  // Agents and Sessions list the project's own; ‹ All projects returns to the namespaces.
  await overlay.getByRole("tab", { name: "Agents" }).click()
  await expect(overlay.getByTestId("project-agent").first()).toBeVisible()
  await overlay.getByRole("button", { name: "All projects" }).click()
  await expect(overlay.getByRole("tab", { name: "OpenCode" })).toHaveAttribute("aria-selected", "true")
  await expect(page).not.toHaveURL(/project=/)
})
