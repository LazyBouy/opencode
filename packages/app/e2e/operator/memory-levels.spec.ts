import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// The Memory page's Memory and Settings tabs (memory_spec.md §8): a project's three levels, each memory in
// the overlay (read, edit, delete to Trash), a new memory, MEMORY.md as text, and the settings.

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

const pick = async (page: Page, label: string, option: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${option}$`) })
    .click()
}

test("the Memory tab lists the three levels; a memory opens in the overlay, is edited and deleted", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/memory${dir}`)
  await expect(page.getByRole("tab", { name: "Memory", exact: true })).toHaveAttribute("aria-selected", "true")
  const namespace = page.getByTestId("memory-level-namespace")
  const project = page.getByTestId("memory-level-project")
  await expect(namespace).toContainText("Namespace memory · OpenCode")
  await expect(namespace).toContainText("Org conventions")
  await expect(page.getByTestId("memory-level-agent")).toContainText("Agent memory · build")
  await expect(page.getByTestId("memory-level-agent")).toContainText("No memories here yet.")
  await expect(project.getByTestId("memory-level-size")).toContainText("1 of 200 lines")
  // A hand-written line and a file no line names are flagged.
  await expect(project.getByTestId("memory-level-invalid")).toContainText("A note by hand")
  await expect(project.getByTestId("memory-level-unindexed")).toContainText("orphan.md")

  await project.getByRole("row", { name: /Release checklist/ }).click()
  const overlay = page.getByRole("dialog")
  const fields = overlay.getByTestId("memory-entry")
  await expect(fields).toContainText("Steps before tagging a release")
  await expect(fields).toContainText("release-checklist.md")
  await expect(fields).toContainText("agent build · session ses_op_1")
  await expect(fields.locator('[data-component="operator-code"]')).toHaveText("1. Run the tests\n2. Tag")

  await overlay.getByRole("button", { name: "Edit", exact: true }).click()
  await overlay.getByLabel("Description", { exact: true }).fill("The steps before tagging a release")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.memory.writes.length).toBe(1)
  expect(state.memory.writes[0]).toMatchObject({
    method: "PUT",
    body: {
      level: "project",
      file: "release-checklist.md",
      title: "Release checklist",
      description: "The steps before tagging a release",
      content: "1. Run the tests\n2. Tag",
    },
  })
  await expect(fields).toContainText("The steps before tagging a release")

  // Delete moves it to Trash, after asking.
  await overlay.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("button", { name: "Yes, move to Trash" }).click()
  await expect.poll(() => state.memory.writes.length).toBe(2)
  expect(state.memory.writes[1]).toMatchObject({
    method: "DELETE",
    body: { level: "project", file: "release-checklist.md" },
  })
})

test("a new memory and MEMORY.md as text, each in the overlay", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/memory${dir}`)
  const agent = page.getByTestId("memory-level-agent")
  await agent.getByRole("button", { name: "New memory" }).click()
  const overlay = page.getByRole("dialog")
  const save = overlay.getByRole("button", { name: "Save", exact: true })
  await overlay.getByLabel("Title", { exact: true }).fill("Prefers short answers")
  await expect(save).toBeDisabled()
  await overlay.getByLabel("Description", { exact: true }).fill("The user wants answers under five lines")
  await overlay.getByLabel("Text", { exact: true }).fill("Keep answers short.")
  await save.click()
  await expect.poll(() => state.memory.writes.length).toBe(1)
  expect(state.memory.writes[0]!.body).toEqual({
    level: "agent",
    title: "Prefers short answers",
    description: "The user wants answers under five lines",
    content: "Keep answers short.",
  })
  await expect(overlay.getByTestId("memory-entry")).toContainText("The user wants answers under five lines")
  await overlay.getByRole("button", { name: "Close" }).click()

  await page.getByTestId("memory-level-project").getByRole("button", { name: "Edit MEMORY.md as text" }).click()
  const index = overlay.getByLabel("MEMORY.md", { exact: true })
  await expect(index).toHaveValue(
    "- [Release checklist](release-checklist.md) — Steps before tagging a release\nA note by hand",
  )
  await index.fill("- [Release checklist](release-checklist.md) — Steps before tagging a release")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.memory.writes.length).toBe(2)
  expect(state.memory.writes[1]).toMatchObject({
    path: "/operator/memory/index",
    body: { level: "project", text: "- [Release checklist](release-checklist.md) — Steps before tagging a release" },
  })
})

test("Settings: committing .memory, the index limits, and a project's own choice", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/memory${dir}&tab=settings`)
  const settings = page.getByTestId("memory-settings")
  await settings.locator('[data-slot="switch-control"]').click()
  await expect.poll(() => state.memory.writes.length).toBe(1)
  expect(state.memory.writes[0]!.body).toEqual({ commit: true })
  await settings.getByLabel("Index lines in prompts", { exact: true }).fill("100")
  await settings.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.memory.writes.length).toBe(2)
  expect(state.memory.writes[1]!.body).toEqual({ indexLines: 100, indexChars: 25000 })
  await expect(settings).toContainText("smoke-project")
  await expect(settings).toContainText(": kept out")
  await pick(page, "Commit .memory in smoke-project", "Off")
  await expect.poll(() => state.memory.writes.length).toBe(3)
  expect(state.memory.writes[2]!.body).toEqual({ project: { key: directory, commit: false } })
})

test("instruction files apply only to OpenCode's projects: elsewhere Files and Database are not shown", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.memory.instructions = false
  await page.goto(`/operator/memory${dir}&tab=files`)
  await expect(page.getByRole("tab", { name: /Files/ })).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "Database" })).toHaveCount(0)
  await expect(page.getByTestId("memory-levels")).toContainText("apply only to the OpenCode namespace's projects")
})

test("a project's record has its own choice for committing .memory", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/projects?project=${encodeURIComponent(directory)}`)
  await pick(page, "Commit .memory in smoke-project", "On")
  await expect.poll(() => state.memory.writes.length).toBe(1)
  expect(state.memory.writes[0]!.body).toEqual({ project: { key: directory, commit: true } })
})
