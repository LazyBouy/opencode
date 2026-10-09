import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator, workspace } from "./mock-operator"

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

test("Add project makes <namespace folder>/<name>, a git repository by default, and opens it", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/projects")
  await page.getByRole("button", { name: "Add project" }).click()
  // Global and OpenCode are both namespaces: Add project asks which.
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^OpenCode$/ })
    .click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "New project in OpenCode" })).toBeVisible()
  await dialog.getByLabel("Name", { exact: true }).fill("demo")
  await expect(dialog.getByTestId("new-project-path")).toHaveText(`${workspace}/opencode/demo`)
  await expect(dialog.getByRole("checkbox", { name: "Create a git repository" })).toBeChecked()
  await dialog.getByRole("button", { name: "Create project" }).click()
  await expect.poll(() => state.prompt.writes.at(-1)?.body).toEqual({ namespace: "opencode", name: "demo", git: true })
  await expect.poll(() => state.projectsOpened).toContain(`${workspace}/opencode/demo`)
  await expect(dialog).toBeHidden()
})

test("Add an existing folder… browses the workspace; a folder can be made a git project there", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/projects")
  await page.getByRole("button", { name: "Add project" }).click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^OpenCode$/ })
    .click()
  await page.getByRole("dialog").getByRole("button", { name: "Add an existing folder…" }).click()
  const browser = page.getByRole("dialog").last()
  const folders = browser.getByRole("list", { name: "Folders" })
  await expect(folders.getByRole("listitem").filter({ hasText: "site" })).toContainText("git")
  await folders.getByRole("button", { name: "apps" }).click()
  await browser.getByRole("button", { name: "Make this folder a git project" }).click()
  await expect.poll(() => state.folderWrites.length).toBe(1)
  expect(state.folderWrites[0].body).toEqual({ path: `${workspace}/apps` })
  await expect(browser).not.toContainText("not a git repository")
  // Outside OpenCode's folder: moved into it, or added as it is.
  await browser.getByRole("button", { name: "Use this folder" }).click()
  const choice = page.getByTestId("new-project-outside")
  await expect(choice).toContainText(`${workspace}/apps isn't in OpenCode's folder.`)
  await choice.getByRole("button", { name: "Add it to OpenCode as it is" }).click()
  await expect.poll(() => state.projectsOpened).toContain(`${workspace}/apps`)
})

test("memory lists files and the database, and edits AGENTS.md", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/memory${dir}`)

  const table = page.locator('[data-component="operator-table"]')
  await expect(table).toContainText("Folder instructions")
  await expect(table).toContainText("When the agent asks for it")
  await expect(table).toContainText("1.5 KB")
  await expect(page.getByRole("button", { name: "Create Global's AGENTS.md" })).toBeVisible()

  // A file opens in the overlay, read-only; Edit, then Save.
  await table.getByRole("row", { name: /SmokeProject\/AGENTS\.md/ }).click()
  const overlay = page.getByRole("dialog")
  await expect(overlay.locator('[data-component="operator-code"]')).toHaveText("# Project rules\nUse Bun.\n")
  await overlay.getByRole("button", { name: "Edit", exact: true }).click()
  const editor = overlay.getByLabel("Text", { exact: true })
  await expect(editor).toHaveValue("# Project rules\nUse Bun.\n")
  await editor.fill("# Project rules\nUse Bun 1.3.\n")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.memoryWrites.length).toBe(1)
  expect(state.memoryWrites[0].body).toEqual({
    path: `${directory}/AGENTS.md`,
    text: "# Project rules\nUse Bun 1.3.\n",
  })
  await overlay.getByRole("button", { name: "Close" }).click()

  await page.getByRole("tab", { name: "Database" }).click()
  await expect(page.locator('[data-slot="operator-tiles"]')).toContainText("5 MB")
  await expect(page.locator('[data-component="operator-table"]')).toContainText("session")
  // A compaction summary opens in the overlay too.
  await page.getByRole("button", { name: /Fix the parser/ }).click()
  await expect(overlay.getByText("We fixed the tokenizer and added tests.")).toBeVisible()
})
