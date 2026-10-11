import { expect, test } from "@playwright/test"
import { directory, mockOperator } from "./mock-operator"

// The models in effect, view-only (default_models_spec.md §7): a namespace's page in Settings and an agent's
// page, each saying where the model comes from.

const dir = `?dir=${encodeURIComponent(directory)}`
const OPUS = "opencode/claude-opus-4-6"

test("an agent without a model of its own shows the project's default and where it comes from", async ({ page }) => {
  const state = await mockOperator(page)
  state.models.settings = { model: OPUS }
  await page.goto(`/operator/agents/build${dir}`)
  const model = page.getByTestId("agent-model")
  await expect(model).toContainText("Default model · Claude Opus 4.6 · OpenCode")
  await expect(model).toContainText("from Settings (Global's config)")
  // An agent with its own model shows it as before.
  await page.goto(`/operator/agents/reviewer${dir}`)
  await expect(page.getByTestId("model-source")).toContainText(OPUS)
  await expect(page.getByTestId("agent-model")).toHaveCount(0)
})

test("a namespace's page shows its default and small model, and opens its row on Providers & Models", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.models.namespaces.opencode = { small_model: OPUS }
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Namespaces" }).click()
  await settings.locator('[data-slot="settings-namespace"]', { hasText: "OpenCode" }).click()
  const view = page.getByRole("dialog").last().getByTestId("namespace-view")
  await expect(view.getByTestId("model-in-effect-model")).toContainText("OpenCode decides")
  await expect(view.getByTestId("model-in-effect-small")).toContainText("from OpenCode's config")
  await view.getByTestId("namespace-models-link").click()
  await expect(page).toHaveURL(/\/operator\/models\?ns=opencode&row=namespace/)
  await expect(page.locator(".settings-v2-dialog")).toHaveCount(0)
  await expect(page.getByTestId("models-row-namespace")).toHaveAttribute("data-highlighted", "")
})
