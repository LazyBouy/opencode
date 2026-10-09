import { expect, type Page, test } from "@playwright/test"
import { directory, mockOperator } from "./mock-operator"

// Iteration 5 fixes, phase 5 (fixes_spec.md §8): the default and small model for every project and
// for all of them, each set on its own, saying how it was chosen and which file a change writes.

const dir = `?dir=${encodeURIComponent(directory)}`

const choose = async (page: Page, label: string, option: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page.locator('[data-component="menu-v2-item"]').filter({ hasText: option }).last().click()
}

test("each project's small model is set on its own, after saying which file it writes", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/models${dir}`)
  const table = page.getByTestId("models-per-project")
  await expect(table.getByTestId("models-row-global")).toContainText("All projects (Global's config)")
  const row = table.locator(`[data-testid="models-row"][data-project="${directory}"]`)
  // How each was chosen, always shown.
  await expect(row).toContainText("OpenCode's own choice")

  await choose(page, "Small model for smoke-project", "Claude Opus 4.6")
  const question = page.getByRole("dialog").filter({ hasText: "Change the Small model for smoke-project?" })
  await expect(question).toContainText("Writes `small_model: opencode/claude-opus-4-6` to")
  await expect(question).toContainText(".opencode/opencode.jsonc")
  await question.getByRole("button", { name: "Save" }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  const write = new URL(state.writes[0]!.url)
  expect(write.searchParams.get("scope")).toBe("project")
  expect(write.searchParams.get("directory")).toBe(directory)
  // Only the small model: the default model stays Default (not set).
  expect(state.writes[0]!.body).toEqual({ small_model: "opencode/claude-opus-4-6" })

  // All projects: the global file.
  await choose(page, "Default model for all projects", "Claude Opus 4.6")
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click()
  await expect.poll(() => state.writes.length).toBe(2)
  expect(new URL(state.writes[1]!.url).searchParams.get("scope")).toBe("global")
  expect(state.writes[1]!.body).toEqual({ model: "opencode/claude-opus-4-6" })
})

test("a project's record has the same two pickers", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/projects?project=${encodeURIComponent(directory)}&psec=models`)
  const pickers = page.getByRole("dialog").getByTestId("project-models")
  await expect(pickers.locator('[data-component="select-v2-root"]')).toHaveCount(2)
  await expect(pickers).toContainText("OpenCode's own choice")
})

test("the table follows the namespace picker: a namespace's projects, under its name when all are shown", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.prompt.namespaces.push({ id: "acme", name: "Acme", purpose: "", createdAt: 1, updatedAt: 1 })
  await page.goto(`/operator/models?ns=*`)
  const table = page.getByTestId("models-per-project")
  // Global is a namespace of its own (the working directory is set).
  await expect(table.getByTestId("models-namespace")).toHaveText(["Global", "OpenCode", "Acme"])
  await expect(table).toContainText("Global has no projects yet.")
  await expect(table).toContainText("Acme has no projects yet.")
  await expect(table.locator(`[data-testid="models-row"][data-project="${directory}"]`)).toBeVisible()

  await page.goto(`/operator/models?ns=acme`)
  await expect(table.getByTestId("models-namespace")).toHaveCount(0)
  await expect(table.locator('[data-testid="models-row"]')).toHaveCount(0)
  await expect(page.getByTestId("models-listed-from")).toContainText("the namespace has no project yet")
})
