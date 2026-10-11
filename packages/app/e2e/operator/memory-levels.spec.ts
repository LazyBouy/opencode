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

test("the Memory tab: the namespace's memory, then a project's, then an agent's, each with its own actions", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/memory${dir}`)
  await expect(page.getByRole("tab", { name: "Memory", exact: true })).toHaveAttribute("aria-selected", "true")
  // The namespace picker at the top scopes the page.
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Namespace"]')).toContainText("OpenCode")
  const namespace = page.getByTestId("memory-level-namespace")
  const project = page.getByTestId("memory-level-project")
  const agent = page.getByTestId("memory-level-agent")
  await expect(namespace).toContainText("Namespace memory · OpenCode")
  await expect(namespace).toContainText("Org conventions")
  expect(state.memory.namespaceQueries).toContain("opencode")
  // The project picker just above the project's memory, the agent picker just above the agent's.
  const levels = page.getByTestId("memory-levels")
  const order = await levels.evaluate((root) =>
    [...root.querySelectorAll('[data-testid^="memory-level-"], [data-component="select-v2-root"]')].map(
      (node) => node.getAttribute("data-testid") ?? node.getAttribute("aria-label"),
    ),
  )
  const sections = ["memory-level-namespace", "memory-level-project", "memory-level-agent", "Project", "Agent"]
  expect(order.filter((item) => sections.includes(item ?? ""))).toEqual([
    "memory-level-namespace",
    "Project",
    "memory-level-project",
    "Agent",
    "memory-level-agent",
  ])
  await expect(agent).toContainText("Agent memory · build")
  await expect(agent).toContainText("No memories here yet.")
  await expect(project.getByTestId("memory-level-size")).toContainText("1 of 200 lines")
  await expect(project.getByTestId("memory-level-invalid")).toContainText("A note by hand")
  await expect(project.getByTestId("memory-level-unindexed")).toContainText("orphan.md")

  await project.getByRole("row", { name: /Release checklist/ }).click()
  const overlay = page.getByRole("dialog")
  const fields = overlay.getByTestId("memory-entry")
  await expect(fields).toContainText("Steps before tagging a release")
  await expect(fields).toContainText("agent build · session ses_op_1")
  await expect(fields.locator('[data-component="operator-code"]')).toHaveText("1. Run the tests\n2. Tag")
  await overlay.getByRole("button", { name: "Edit", exact: true }).click()
  await overlay.getByLabel("Description", { exact: true }).fill("The steps before tagging a release")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.memory.writes.length).toBe(1)
  expect(state.memory.writes[0]).toMatchObject({
    method: "PUT",
    body: { level: "project", file: "release-checklist.md", description: "The steps before tagging a release" },
  })
  await overlay.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("button", { name: "Yes, move to Trash" }).click()
  await expect.poll(() => state.memory.writes.length).toBe(2)
  expect(state.memory.writes[1]).toMatchObject({
    method: "DELETE",
    body: { level: "project", file: "release-checklist.md" },
  })
})

test("each section's New memory and MEMORY.md go to its own level: the namespace's by its name", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/memory${dir}`)
  await page.getByTestId("memory-level-agent").getByRole("button", { name: "New memory" }).click()
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
    agent: "build",
    title: "Prefers short answers",
    description: "The user wants answers under five lines",
    content: "Keep answers short.",
  })
  await overlay.getByRole("button", { name: "Close" }).click()

  await page.getByTestId("memory-level-namespace").getByRole("button", { name: "Edit MEMORY.md as text" }).click()
  const index = overlay.getByLabel("MEMORY.md", { exact: true })
  await expect(index).toHaveValue("- [Org conventions](org-conventions.md) — How we name things")
  await index.fill("- [Org conventions](org-conventions.md) — How we name things\nA note")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.memory.writes.length).toBe(2)
  expect(state.memory.writes[1]).toMatchObject({
    path: "/operator/memory/index",
    body: { level: "namespace", namespace: "opencode" },
  })
})

test("Settings: the namespace's commit choice and limits, its projects' choices, and the server's database", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/memory${dir}&tab=settings`)
  const settings = page.getByTestId("memory-settings")
  await settings.locator('[data-slot="switch-control"]').click()
  await expect.poll(() => state.memory.writes.length).toBe(1)
  expect(state.memory.writes[0]!.body).toEqual({ commit: true, namespace: "opencode" })
  await settings.getByLabel("Index lines in prompts", { exact: true }).fill("100")
  await settings.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.memory.writes.length).toBe(2)
  expect(state.memory.writes[1]!.body).toEqual({ indexLines: 100, indexChars: 25000, namespace: "opencode" })
  await expect(settings).toContainText("smoke-project")
  await pick(page, "Commit .memory in smoke-project", "Off")
  await expect.poll(() => state.memory.writes.length).toBe(3)
  expect(state.memory.writes[2]!.body).toEqual({ namespace: "opencode", project: { key: directory, commit: false } })
  // The database is the server's, for every namespace.
  await expect(page.getByTestId("memory-database")).toContainText("SQLite")
  await expect(page.getByTestId("memory-database")).toContainText("session")
})

test("a namespace without projects: its own memory; Files says instruction files apply only to OpenCode's projects", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.prompt.namespaces.push({ id: "acme", name: "Acme", purpose: "", createdAt: 1, updatedAt: 1 })
  await page.goto(`/operator/memory${dir}&ns=acme`)
  await expect(page.getByTestId("memory-level-namespace")).toContainText("Namespace memory · Acme")
  await expect(page.getByTestId("memory-levels")).toContainText("This namespace has no projects yet")
  await expect(page.getByTestId("memory-level-project")).toHaveCount(0)
  await page.getByRole("tab", { name: /Files/ }).click()
  await expect(page.getByText("apply only to the OpenCode namespace's projects")).toBeVisible()
})

test("a project's record has its own choice for committing .memory", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/projects?project=${encodeURIComponent(directory)}`)
  await pick(page, "Commit .memory in smoke-project", "On")
  await expect.poll(() => state.memory.writes.length).toBe(1)
  expect(state.memory.writes[0]!.body).toEqual({ namespace: "opencode", project: { key: directory, commit: true } })
})
