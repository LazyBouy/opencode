import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockModelDefaults, modelDefaultsMock, modelProviders } from "./mock-models"
import { mockOperator } from "./mock-operator"

// Settings → Models (default_models_spec.md §4): the server-wide default and small model above upstream's list,
// with a Default and a Small radio on every row. A change can be undone in the tab.

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: modelProviders,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await mockOperator(page)
})

// The settings dialog is modal: the tooltip and the toast are outside it, hidden from role queries.
const tooltip = (page: Page) => page.locator('[role="tooltip"]')

const openModels = async (page: Page) => {
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const dialog = page.locator(".settings-v2-dialog")
  await dialog.getByRole("tab", { name: "Models" }).click()
  return dialog
}

test("the two fields say what is set, or what OpenCode decides now; each (i) says how", async ({ page }) => {
  await mockModelDefaults(page)
  const dialog = await openModels(page)
  const model = dialog.getByTestId("settings-default-model")
  const small = dialog.getByTestId("settings-default-small_model")
  await expect(model.getByTestId("settings-default-value")).toContainText("Claude Sonnet 4.5")
  await expect(model.getByTestId("settings-default-value")).toContainText("Anthropic")
  // Not set: the model OpenCode's own logic picks now, tagged Auto; a set model has no tag.
  const smallValue = small.getByTestId("settings-default-value")
  await expect(smallValue).toContainText("Claude Haiku 4.5")
  await expect(smallValue.getByTestId("settings-default-auto")).toHaveText("Auto")
  await expect(model.getByTestId("settings-default-auto")).toHaveCount(0)
  await expect(small.getByRole("button", { name: "Let OpenCode decide" })).toBeDisabled()
  await expect(dialog).toContainText("Namespaces and projects can override these on Providers & Models.")

  await model.getByRole("button", { name: "About Default model" }).hover()
  await expect(tooltip(page)).toContainText("Set in Settings, in Global's config")
  await small.getByRole("button", { name: "About Small default model" }).hover()
  await expect(tooltip(page)).toContainText(
    "the newest model of the first small family the provider offers: Gemini Flash, then GPT nano, then Claude Haiku",
  )
  await expect(tooltip(page)).toContainText("Right now that's Claude Haiku 4.5.")
})

test("a radio sets the default at once, one per column across providers; Undo puts it back", async ({ page }) => {
  const mock = await mockModelDefaults(page)
  const dialog = await openModels(page)
  const sonnet = dialog.getByRole("radio", { name: "Default model: Claude Sonnet 4.5" })
  const gpt = dialog.getByRole("radio", { name: "Default model: GPT-5" })
  await expect(sonnet).toBeChecked()
  await gpt.check()
  await expect.poll(() => mock.writes.at(-1)).toEqual({ level: "settings", key: "model", model: "openai/gpt-5" })
  await expect(gpt).toBeChecked()
  await expect(sonnet).not.toBeChecked()
  await expect(dialog.getByTestId("settings-default-model")).toContainText("GPT-5")
  // Undo is in the tab: the toast is outside the dialog, and clicking it would close the dialog.
  const change = dialog.getByTestId("settings-model-change")
  await expect(change).toContainText("Default model set to GPT-5")
  await change.getByRole("button", { name: "Undo" }).click()
  await expect
    .poll(() => mock.writes.at(-1))
    .toEqual({ level: "settings", key: "model", model: "anthropic/claude-sonnet-4-5" })
  await expect(sonnet).toBeChecked()

  // The Small column is a group of its own.
  await dialog.getByRole("radio", { name: "Small model: Claude Haiku 4.5" }).check()
  await expect
    .poll(() => mock.writes.at(-1))
    .toEqual({
      level: "settings",
      key: "small_model",
      model: "anthropic/claude-haiku-4-5",
    })
  await expect(sonnet).toBeChecked()
})

test("Let OpenCode decide removes the setting and clears the column", async ({ page }) => {
  const mock = await mockModelDefaults(page)
  const dialog = await openModels(page)
  const model = dialog.getByTestId("settings-default-model")
  await model.getByRole("button", { name: "Let OpenCode decide" }).click()
  await expect.poll(() => mock.writes.at(-1)).toEqual({ level: "settings", key: "model", model: null })
  await expect(model.getByTestId("settings-default-value")).toContainText("Claude Sonnet 4.5")
  await expect(model.getByTestId("settings-default-auto")).toBeVisible()
  // Its (i) says how OpenCode's own logic picks it.
  await model.getByRole("button", { name: "About Default model" }).hover()
  await expect(tooltip(page)).toContainText("the model last used in the terminal app (TUI)")
  await expect(tooltip(page)).toContainText("its top model by OpenCode's ranking")
  await expect(dialog.getByRole("radio", { name: "Default model: Claude Sonnet 4.5" })).not.toBeChecked()
})

test("only a shown model can be a default, and a default stays shown; search keeps the fields", async ({ page }) => {
  const mock = await mockModelDefaults(page)
  const dialog = await openModels(page)
  const row = dialog.getByTestId("settings-model-openai/gpt-5")
  await row.locator('[data-slot="switch-control"]').click()
  await expect(row.getByRole("switch")).not.toBeChecked()
  await expect(dialog.getByRole("radio", { name: "Default model: GPT-5" })).toBeDisabled()
  await expect(dialog.getByRole("radio", { name: "Small model: GPT-5" })).toBeDisabled()
  // Claude Sonnet 4.5 is the default model: it can't be hidden until another is chosen.
  await expect(dialog.getByTestId("settings-model-anthropic/claude-sonnet-4-5").getByRole("switch")).toBeDisabled()
  expect(mock.writes).toEqual([])

  await dialog.getByRole("searchbox", { name: "Search models" }).fill("haiku")
  await expect(dialog.getByTestId("settings-default-model")).toContainText("Claude Sonnet 4.5")
  await expect(dialog.getByTestId("settings-model-openai/gpt-5")).toHaveCount(0)
})

test("the environment overriding Settings is said in the field and its (i)", async ({ page }) => {
  const mock = modelDefaultsMock()
  mock.settings = {}
  mock.environment = { variable: "OPENCODE_CONFIG", model: "openai/gpt-5" }
  await mockModelDefaults(page, mock)
  const dialog = await openModels(page)
  const model = dialog.getByTestId("settings-default-model")
  await expect(model.getByTestId("settings-default-value")).toHaveText(
    "Set by the environment (OPENCODE_CONFIG) · GPT-5",
  )
  await model.getByRole("button", { name: "About Default model" }).hover()
  await expect(tooltip(page)).toContainText(
    "The environment sets model (OPENCODE_CONFIG), so this setting has no effect while it does.",
  )
})

test("Refresh runs OpenCode's logic again for both fields, and shows a change made elsewhere", async ({ page }) => {
  const mock = await mockModelDefaults(page)
  const dialog = await openModels(page)
  const small = dialog.getByTestId("settings-default-small_model").getByTestId("settings-default-value")
  await expect(small).toContainText("Claude Haiku 4.5")
  // OpenCode's pick changes (another provider connected, another model used in the TUI).
  mock.decides.small = "openai/gpt-5"
  await dialog.getByRole("button", { name: "About Refresh" }).hover()
  await expect(tooltip(page)).toContainText("Runs OpenCode's own logic again for both fields")
  await dialog.getByTestId("settings-models-refresh").click()
  await expect(small).toContainText("GPT-5")
  await expect(small.getByTestId("settings-default-auto")).toBeVisible()
  // Set elsewhere (the config file, another browser): no longer Auto.
  mock.settings.small_model = "anthropic/claude-haiku-4-5"
  await dialog.getByTestId("settings-models-refresh").click()
  await expect(small).toContainText("Claude Haiku 4.5")
  await expect(small.getByTestId("settings-default-auto")).toHaveCount(0)
  await expect(dialog.getByRole("radio", { name: "Small model: Claude Haiku 4.5" })).toBeChecked()
})

test("choosing a default model sets only the default: the small model stays as it was", async ({ page }) => {
  const mock = await mockModelDefaults(page)
  const dialog = await openModels(page)
  await dialog.getByRole("radio", { name: "Default model: GPT-5" }).check()
  await expect.poll(() => mock.writes).toEqual([{ level: "settings", key: "model", model: "openai/gpt-5" }])
  // The small model stays Auto: OpenCode's pick, not a setting.
  await expect(dialog.getByTestId("settings-default-small_model").getByTestId("settings-default-auto")).toBeVisible()
  await expect(dialog.getByRole("radio", { name: "Small model: GPT-5" })).not.toBeChecked()
})
