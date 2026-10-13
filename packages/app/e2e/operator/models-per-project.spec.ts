import { expect, type Page, test } from "@playwright/test"
import { directory, mockOperator } from "./mock-operator"
import { idFor } from "./mock-namespaces"

// Projects are labelled "name · id" (specs/docs/issues/002).
const smoke = `smoke-project · ${idFor(directory)}`

// Providers & Models (default_models_spec.md §5): the defaults in effect for the namespace in scope, then
// Models per project, its namespace's row (its config) and one row per project (the project's config), each
// with Inherit or a model and a short "from" line; the model overlay says where a model is the default.

const choose = async (page: Page, label: string, option: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page.locator('[data-component="menu-v2-item"]').filter({ hasText: option }).last().click()
}
const OPUS = "opencode/claude-opus-4-6"
const projectRow = (page: Page) =>
  page.getByTestId("models-per-project").locator(`[data-testid="models-row"][data-project="${directory}"]`)

test("Defaults for the namespace say where each model comes from; Settings opens Settings → Models", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.models.settings = { model: OPUS }
  await page.goto("/operator/models?ns=opencode")
  const block = page.getByTestId("model-defaults-block")
  await expect(block).toContainText("Defaults for OpenCode")
  const model = block.getByTestId("model-in-effect-model")
  await expect(model).toContainText("Claude Opus 4.6 · OpenCode")
  await expect(model).toContainText("from Settings (Global's config)")
  await expect(block.getByTestId("model-in-effect-small")).toContainText("OpenCode decides")
  await block.getByRole("button", { name: "About Default model" }).hover()
  await expect(page.getByRole("tooltip")).toContainText(
    "OpenCode's config doesn't set a default model, so it comes from Settings (Global's config), which sets Claude Opus 4.6 · OpenCode.",
  )
  await model.getByRole("button", { name: "Settings" }).click()
  await expect(page.locator(".settings-v2-dialog").getByTestId("settings-model-defaults")).toBeVisible()
})

test("the namespace's row writes its config; a project's row writes its own, after the copy question", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.models.settings = { model: OPUS }
  await page.goto("/operator/models?ns=opencode")
  const table = page.getByTestId("models-per-project")
  const namespaceRow = table.locator('[data-testid="models-row-namespace"][data-namespace="opencode"]')
  await expect(namespaceRow).toContainText("All projects (OpenCode's config)")
  await expect(table).not.toContainText("How chosen")
  const row = projectRow(page)
  await expect(row.getByTestId("model-from").first()).toHaveText("From Settings (Global's config)")
  await expect(row.locator('[data-component="select-v2"]').first()).toContainText(
    "Inherit · Claude Opus 4.6 from Settings (Global's config)",
  )

  // The namespace's own small model: its config.
  // Provider first, then one of its models.
  await choose(page, "Small model for All projects (OpenCode's config): provider", "OpenCode")
  await choose(page, "Small model for All projects (OpenCode's config): model", "Claude Opus 4.6")
  const question = page.getByRole("dialog").filter({ hasText: "Change the Small model for All projects" })
  await expect(question).toContainText("Writes `small_model: opencode/claude-opus-4-6` to")
  await question.getByRole("button", { name: "Save" }).click()
  await expect
    .poll(() => state.models.writes.at(-1))
    .toEqual({ level: "namespace", namespace: "opencode", key: "small_model", model: OPUS })
  await expect(row.getByTestId("model-from").last()).toHaveText("From OpenCode's config")

  // The project's default model: its own config, which it doesn't have yet.
  await choose(page, `Default model for ${smoke}: provider`, "OpenCode")
  await choose(page, `Default model for ${smoke}: model`, "Claude Opus 4.6")
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click()
  await expect(page.getByRole("dialog").filter({ hasText: "Save as this project's own config?" })).toBeVisible()
  await page.getByRole("button", { name: "Save as project config" }).click()
  await expect
    .poll(() => state.models.writes.at(-1))
    .toEqual({ level: "project", directory, key: "model", model: OPUS, confirmCopy: true })
  // The same model as it would inherit: Follow takes the project's setting out.
  await expect(row.getByTestId("model-from").first()).toContainText(
    "Set for this project (same as Settings (Global's config))",
  )
  await row.getByRole("button", { name: "Follow Settings (Global's config)" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click()
  await expect
    .poll(() => state.models.writes.at(-1))
    .toEqual({ level: "project", directory, key: "model", model: null })
  await expect(row.getByTestId("model-from").first()).toHaveText("From Settings (Global's config)")
})

test("Global's row is read-only: its config is Settings", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/models?ns=global")
  const row = page.getByTestId("models-per-project").locator('[data-testid="models-row-namespace"]')
  await expect(row).toContainText("All projects (Settings)")
  await expect(row.locator('[data-component="select-v2"]')).toHaveCount(0)
  await row.getByRole("button", { name: "Change in Settings → Models" }).first().click()
  await expect(page.locator(".settings-v2-dialog").getByTestId("settings-model-defaults")).toBeVisible()
})

test("the table follows the namespace picker: each namespace's own row, then its projects", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.namespaces.push({ id: "acme", name: "Acme", purpose: "", createdAt: 1, updatedAt: 1 })
  await page.goto(`/operator/models?ns=*`)
  await expect(page.getByTestId("model-defaults-block")).toContainText("Defaults in Settings")
  await expect(page.getByTestId("model-defaults-block")).toContainText("pick a namespace to see its own")
  const table = page.getByTestId("models-per-project")
  await expect(table.getByTestId("models-row-namespace")).toHaveText([
    /All projects \(Settings\)/,
    /All projects \(OpenCode's config\)/,
    /All projects \(Acme's config\)/,
  ])
  await expect(table).toContainText("Acme has no projects yet.")
  await expect(projectRow(page)).toBeVisible()

  await page.goto(`/operator/models?ns=acme`)
  await expect(table.getByTestId("models-row-namespace")).toHaveCount(1)
  await expect(table.locator('[data-testid="models-row"]')).toHaveCount(0)
  await expect(page.getByTestId("models-listed-from")).toContainText("the namespace has no project yet")
})

test("a project's record shows the models in effect, view-only, with a way to its row", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/projects?project=${encodeURIComponent(directory)}&psec=models`)
  const models = page.getByRole("dialog").getByTestId("project-models")
  await expect(models.locator('[data-component="select-v2-root"]')).toHaveCount(0)
  await expect(models.getByTestId("model-in-effect-model")).toContainText("Claude Opus 4.6")
  await expect(models.getByTestId("model-in-effect-model")).toContainText("OpenCode decides")
  await models.getByRole("link", { name: "Change on Providers & Models" }).click()
  await expect(page).toHaveURL(/\/operator\/models\?ns=opencode&project=/)
  await expect(projectRow(page)).toHaveAttribute("data-highlighted", "")
})

test("the model overlay says where the model is the default, with no Use as buttons; tags follow the namespace", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.models.settings = { model: OPUS }
  await page.goto(`/operator/models?ns=opencode`)
  const tag = page.locator('[title="Default for OpenCode (from Settings (Global\'s config))"]')
  await expect(tag).toBeVisible()
  await page.goto(`/operator/models?ns=opencode&model=${encodeURIComponent(OPUS)}`)
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByTestId("model-default-for")).toContainText("Settings · default model")
  await expect(dialog.getByRole("button", { name: "Use as default model (Global)" })).toHaveCount(0)
})
