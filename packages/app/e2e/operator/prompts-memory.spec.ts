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

test("add project browses the workspace, creates a git folder and opens it", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/projects")
  await page.getByRole("button", { name: "Add project" }).click()

  const dialog = page.getByRole("dialog")
  const folders = dialog.getByRole("list", { name: "Folders" })
  await expect(folders).toContainText("apps")
  await expect(folders.getByRole("listitem").filter({ hasText: "site" })).toContainText("git")
  await folders.getByRole("button", { name: "apps" }).click()
  await expect(dialog.getByRole("navigation", { name: "Folder path" })).toContainText("apps")
  await expect(dialog).toContainText("not a git repository")

  await dialog.getByRole("textbox", { name: "New folder name" }).fill("demo")
  await dialog.getByRole("button", { name: "Create folder" }).click()
  await expect.poll(() => state.folderWrites.length).toBe(1)
  expect(state.folderWrites[0].body).toEqual({ parent: `${workspace}/apps`, name: "demo", git: true })
  await expect(dialog.getByRole("navigation", { name: "Folder path" })).toContainText("demo")
  await expect(dialog).not.toContainText("not a git repository")

  await dialog.getByRole("button", { name: "Use this folder" }).click()
  await expect.poll(() => state.projectsOpened).toContain(`${workspace}/apps/demo`)
  await expect(dialog).toBeHidden()
})

test("an existing folder can be made a git project", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/projects")
  await page.getByRole("button", { name: "Add project" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("list", { name: "Folders" }).getByRole("button", { name: "apps" }).click()
  await dialog.getByRole("button", { name: "Make this folder a git project" }).click()
  await expect.poll(() => state.folderWrites.length).toBe(1)
  expect(state.folderWrites[0].body).toEqual({ path: `${workspace}/apps` })
  await expect(dialog).not.toContainText("not a git repository")
})

test("memory lists files and the database, and edits AGENTS.md", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/memory${dir}`)

  const table = page.locator('[data-component="operator-table"]')
  await expect(table).toContainText("Folder instructions")
  await expect(table).toContainText("When the agent asks for it")
  await expect(table).toContainText("1.5 KB")
  await expect(page.getByRole("button", { name: "Create global AGENTS.md" })).toBeVisible()

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
