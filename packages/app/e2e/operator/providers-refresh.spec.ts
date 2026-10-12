import { expect, test, type Page } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// specs/docs/issues/001: a provider connected in Settings shows on Providers & Models at once, without a reload.

const model = (providerID: string, id: string, name: string) => ({
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
  limit: { context: 200_000, output: 8_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})
const opencode = { id: "opencode", name: "OpenCode", source: "api", env: [], options: {}, models: {} }
const openrouter = {
  id: "openrouter",
  name: "OpenRouter",
  source: "api",
  env: ["OPENROUTER_API_KEY"],
  options: {},
  models: { "openai/gpt-5": model("openrouter", "openai/gpt-5", "GPT-5 (OpenRouter)") },
}

async function setup(page: Page) {
  const connected = { openrouter: false }
  const keys: Array<{ integrationID: string }> = []
  const events: unknown[] = []
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: () => ({
      all: [
        { id: "opencode", name: "OpenCode", models: {} },
        { id: "openrouter", name: "OpenRouter", models: { "openai/gpt-5": { id: "openai/gpt-5", name: "GPT-5" } } },
      ],
      connected: connected.openrouter ? ["opencode", "openrouter"] : ["opencode"],
      default: {},
    }),
    integrationMethods: { openrouter: [{ type: "api", label: "API key" }] },
    onConnectKey: (input) => {
      keys.push(input)
      connected.openrouter = true
      // The server reloads the project whose list it was (provider-refresh.ts): its instance is disposed.
      events.push({ directory, payload: { type: "server.instance.disposed", properties: { directory } } })
    },
    events: () => events.splice(0),
    eventRetry: 200,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  const state = await mockOperator(page)
  // The project's provider list, as the server gives it once the key is set.
  await page.route("**/config/providers*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        providers: connected.openrouter ? [opencode, openrouter] : [opencode],
        default: { opencode: "big-pickle" },
      }),
    }),
  )
  return { state, keys }
}

test("a provider connected in Settings shows on Providers & Models without a reload", async ({ page }) => {
  const { keys } = await setup(page)
  await page.goto("/operator/models")
  const tile = page.locator('[data-slot="operator-stat-label"]', { hasText: "OpenRouter" })
  await expect(page.getByText("OpenCode", { exact: true }).first()).toBeVisible()
  await expect(tile).toHaveCount(0)

  await page.getByRole("button", { name: "Connect a provider" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings
    .locator(".settings-v2-provider-row", { hasText: "OpenRouter" })
    .getByRole("button", { name: "Connect" })
    .click()
  await page.locator('[data-input="provider-api-key"]').fill("sk-or-mock")
  await page.locator('[data-action="provider-connect-submit"]').click()
  await expect.poll(() => keys.length).toBe(1)
  await page.keyboard.press("Escape")

  // No reload: the page's list was fetched again.
  await expect(page.getByText("OpenRouter").first()).toBeVisible()
  await expect(page.getByText("GPT-5 (OpenRouter)")).toBeVisible()
})

test("while the project's sessions run, the page says its list updates when they end", async ({ page }) => {
  const { state } = await setup(page)
  state.providersWaiting = [directory]
  await page.goto("/operator/models")
  await expect(page.getByTestId("providers-waiting")).toContainText(
    "This project's list updates when none of its sessions is running.",
  )
})
