import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"
import { idFor } from "./mock-namespaces"

// Projects are labelled "name · id" (specs/docs/issues/002).
const smoke = `smoke-project · ${idFor(directory)}`

// Long lists (the user's rule, 2026-10-11): a list of more than 10 items can be searched, sorted A→Z or Z→A
// (alphanumerically) and is shown a page at a time: pickers, tables, and Settings → Models' provider groups.

const many = Array.from({ length: 12 }, (_, index) => ({ id: `m${index + 1}`, name: `Model ${index + 1}` }))

const catalogModel = (providerID: string, id: string, name: string) => ({
  id,
  providerID,
  name,
  api: { id, url: "", npm: "" },
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 10_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "",
})

// The project's providers: OpenCode with one model, OpenRouter with twelve.
const catalog = (page: Page) =>
  page.route("**/config/providers*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          {
            id: "opencode",
            name: "OpenCode",
            source: "api",
            env: [],
            options: {},
            models: { "claude-opus-4-6": catalogModel("opencode", "claude-opus-4-6", "Claude Opus 4.6") },
          },
          {
            id: "openrouter",
            name: "OpenRouter",
            source: "api",
            env: [],
            options: {},
            models: Object.fromEntries(many.map((item) => [item.id, catalogModel("openrouter", item.id, item.name)])),
          },
        ],
        default: { opencode: "claude-opus-4-6", openrouter: "m1" },
      }),
    }),
  )

const choose = async (page: Page, label: string, option: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page.locator('[data-component="menu-v2-item"]').filter({ hasText: option }).last().click()
}

test("a picker of more than 10 models searches, sorts and pages them", async ({ page }) => {
  const state = await mockOperator(page)
  await catalog(page)
  await page.goto("/operator/models?ns=opencode")
  await choose(page, `Default model for ${smoke}: provider`, "OpenRouter")
  const label = `Default model for ${smoke}: model`
  await page
    .locator(`[data-component="operator-list-picker"][aria-label="${label}"] [data-slot="list-picker-trigger"]`)
    .click()
  const list = page.locator('[data-component="operator-list-picker-content"]')
  const options = list.getByRole("option")
  // A→Z, alphanumerically (2 before 10), ten at a time.
  await expect(options).toHaveCount(10)
  await expect(options.nth(1)).toHaveText("Model 2")
  await expect(options.nth(9)).toHaveText("Model 10")
  await expect(list.getByTestId("pager")).toContainText("1–10 of 12")
  await list.getByRole("button", { name: "Next page" }).click()
  await expect(options).toHaveText(["Model 11", "Model 12"])
  await list.getByTestId("list-sort").click()
  await expect(options.first()).toHaveText("Model 12")
  await list.getByRole("searchbox").fill("11")
  await expect(options).toHaveText(["Model 11"])
  await options.first().click()
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click()
  await page.getByRole("button", { name: "Save as project config" }).click()
  await expect
    .poll(() => state.models.writes.at(-1))
    .toEqual({ level: "project", directory, key: "model", model: "openrouter/m11", confirmCopy: true })
})

test("a table of more than 10 rows is shown a page at a time", async ({ page }) => {
  await mockOperator(page)
  await catalog(page)
  await page.goto("/operator/models?ns=opencode")
  const table = page
    .locator('[data-component="operator-table"]')
    .filter({ has: page.getByRole("table", { name: "Providers & Models" }) })
  await expect(table.getByTestId("pager")).toContainText("1–10 of 13")
  await expect(table.locator("tbody tr")).toHaveCount(10)
  await table.getByRole("button", { name: "Next page" }).click()
  await expect(table.locator("tbody tr")).toHaveCount(3)
  await table.getByRole("combobox", { name: "Per page" }).selectOption("25")
  await expect(table.locator("tbody tr")).toHaveCount(13)
})

test("Settings → Models sorts and pages a provider of more than 10 models", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: {
      all: [{ id: "openrouter", name: "OpenRouter", models: Object.fromEntries(many.map((item) => [item.id, item])) }],
      connected: ["openrouter"],
      default: { openrouter: "m1" },
    },
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await mockOperator(page)
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const dialog = page.locator(".settings-v2-dialog")
  await dialog.getByRole("tab", { name: "Models" }).click()
  const group = dialog.locator('[data-component="settings-models-provider"]').filter({ hasText: "OpenRouter" })
  await expect(group.getByTestId("pager")).toContainText("1–10 of 12")
  await expect(group.getByTestId("settings-model-openrouter/m10")).toBeVisible()
  await group.getByTestId("list-sort").click()
  await expect(group.getByTestId("settings-model-openrouter/m12")).toBeVisible()
  await expect(group.getByTestId("settings-model-openrouter/m1")).toHaveCount(0)
  await group.getByRole("button", { name: "Next page" }).click()
  await expect(group.getByTestId("settings-model-openrouter/m1")).toBeVisible()
})
