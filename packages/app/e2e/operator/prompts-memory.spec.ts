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

test("an agent's Prompt tab shows every section with its source, and leads to its editor", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=prompt`)

  const sections = page.locator('[data-slot="operator-prompt-section"]')
  await expect(sections).toHaveCount(5)
  const facts = page.locator('[data-component="operator-facts"]')
  await expect(facts).toContainText("OpenCode")
  await expect(facts).toContainText("Default")
  await expect(facts).toContainText("From profile")
  await expect(sections.nth(0)).toContainText("Purpose")
  await expect(sections.nth(0)).toContainText("Mandatory")
  await expect(sections.nth(0)).toContainText("Be terse.")
  await expect(sections.nth(1)).toContainText("Identity")
  await expect(sections.nth(3)).toContainText("Project instructions")
  await expect(sections.nth(3)).toContainText("SmokeProject/AGENTS.md")
  await expect(sections.nth(4)).toContainText("<available_skills>")
  await expect(page.getByRole("switch")).toHaveCount(0)

  await page.getByText("Exactly as sent (2 system messages)").click()
  await expect(page.locator('[data-slot="operator-details"] [data-component="operator-code"]').first()).toHaveText(
    "Be terse.\nWe build editors.",
  )

  state.profile.layers.push({
    id: "terse",
    name: "Terse",
    section: "base",
    overrides: "base.default",
    projects: ["opencode"],
    priority: 50,
    enabled: true,
    text: "Be terse.",
    origin: "profile",
  })
  await sections.nth(0).getByRole("button", { name: "Edit" }).click()
  await expect(page).toHaveURL(/\/operator\/profile\?view=layers&layer=terse/)
  const editor = page.getByLabel("Text", { exact: true })
  await expect(editor).toHaveValue("Be terse.")
  await editor.fill("Be terse and kind.")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.profileWrites.length).toBe(1)
  expect(state.profileWrites[0]).toMatchObject({ method: "PUT", path: "/operator/prompt-profile/layer/terse" })
  expect(state.profileWrites[0].body).toMatchObject({
    text: "Be terse and kind.",
    overrides: "base.default",
    projects: ["opencode"],
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

  await table.getByRole("row", { name: /SmokeProject\/AGENTS\.md/ }).click()
  const editor = page.getByLabel("Text", { exact: true })
  await expect(editor).toHaveValue("# Project rules\nUse Bun.\n")
  await editor.fill("# Project rules\nUse Bun 1.3.\n")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.memoryWrites.length).toBe(1)
  expect(state.memoryWrites[0].body).toEqual({
    path: `${directory}/AGENTS.md`,
    text: "# Project rules\nUse Bun 1.3.\n",
  })

  await page.getByRole("tab", { name: "Database" }).click()
  await expect(page.locator('[data-slot="operator-tiles"]')).toContainText("5 MB")
  await expect(page.locator('[data-component="operator-table"]')).toContainText("session")
  await page.getByText(/Fix the parser ·/).click()
  await expect(page.getByText("We fixed the tokenizer and added tests.")).toBeVisible()
})
