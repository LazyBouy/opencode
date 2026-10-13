import { expect, type Page, test } from "@playwright/test"
import { directory, mockOperator } from "./mock-operator"

// The agent form's model (agent_form_spec.md §2, default_models_spec.md §8): Model source (Default model, Small
// model, Pick a model), a provider and one of its models, a variant built from the model; a new agent starts on
// the default model in effect where it's saved, copied in.

const dir = `?dir=${encodeURIComponent(directory)}`
const OPUS = "opencode/claude-opus-4-6"
const GPT = "openai/gpt-5"

const model = (providerID: string, id: string, name: string, variants?: Record<string, Record<string, unknown>>) => ({
  id,
  providerID,
  name,
  api: { id, url: "", npm: "" },
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
  limit: { context: 200_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "",
  ...(variants ? { variants } : {}),
})

// Two providers; GPT-5 has reasoning-effort variants.
const providers = async (page: Page) =>
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
            models: { "claude-opus-4-6": model("opencode", "claude-opus-4-6", "Claude Opus 4.6") },
          },
          {
            id: "openai",
            name: "OpenAI",
            source: "api",
            env: [],
            options: {},
            models: {
              "gpt-5": model("openai", "gpt-5", "GPT-5", {
                low: { reasoningEffort: "low" },
                high: { reasoningEffort: "high" },
              }),
            },
          },
        ],
        default: { opencode: "claude-opus-4-6", openai: "gpt-5" },
      }),
    }),
  )

const choose = async (page: Page, label: string, option: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page.locator('[data-component="menu-v2-item"]').filter({ hasText: option }).last().click()
}
const source = (page: Page, name: string) =>
  page.getByRole("group", { name: "Model source" }).getByText(name, { exact: true }).click()

test("a new agent starts on the default model where it's saved, copied in; Save in changes it until touched", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await providers(page)
  state.models.projects[directory] = { namespace: "opencode", model: GPT, own: true }
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("docs")
  const select = (label: string) =>
    page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`)
  await expect(select("Provider")).toContainText("OpenAI")
  await expect(select("Model")).toContainText("GPT-5")
  await expect(page.getByTestId("agent-model-now")).toContainText("default model, copied in")
  // Saved in Global: Settings' default (here OpenCode decides it).
  await choose(page, "Namespace", "Global · global")
  await expect(select("Provider")).toContainText("OpenCode")
  await expect(select("Model")).toContainText("Claude Opus 4.6")
  await expect(page.getByTestId("agent-model-now")).toHaveText(
    "The default model in Settings, copied in. Changing it there later won't change this agent.",
  )
  // Once a model is picked, Save in no longer changes it.
  await choose(page, "Provider", "OpenAI")
  await choose(page, "Namespace", "OpenCode · opencode")
  await expect(select("Model")).toContainText("GPT-5")
  await choose(page, "Variant", "Reasoning effort: high")
  await page.getByRole("button", { name: "Create agent" }).click()
  await expect.poll(() => state.agentWrites.length).toBe(1)
  expect(state.agentWrites[0].body).toMatchObject({ name: "docs", model: GPT, variant: "high" })
  expect(state.agentWrites[0].body).not.toHaveProperty("modelSource")
})

test("Small model and Default model: no model sent, the variant follows the rules", async ({ page }) => {
  const state = await mockOperator(page)
  await providers(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("scout")
  await source(page, "Small model")
  await expect(page.getByTestId("agent-model-now")).toContainText("Uses the small model: Claude Opus 4.6 · OpenCode")
  // The small model has no variants.
  await expect(page.getByText("This model has no variants.")).toBeVisible()
  await page.getByRole("button", { name: "Create agent" }).click()
  await expect.poll(() => state.agentWrites.length).toBe(1)
  expect(state.agentWrites[0].body).toMatchObject({ name: "scout", modelSource: "small" })
  expect(state.agentWrites[0].body).not.toHaveProperty("model")

  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("plain")
  await source(page, "Default model")
  await expect(page.getByText("The variant applies only when the agent has its own model")).toBeVisible()
  await expect(page.getByTestId("agent-model-now")).toContainText("Uses the default model: Claude Opus 4.6 · OpenCode")
  await page.getByRole("button", { name: "Create agent" }).click()
  await expect.poll(() => state.agentWrites.length).toBe(2)
  expect(state.agentWrites[1].body).not.toHaveProperty("model")
  expect(state.agentWrites[1].body).not.toHaveProperty("modelSource")
})

test("editing a built-in agent without a model shows Default model and what it uses; no prefill", async ({ page }) => {
  const state = await mockOperator(page)
  await providers(page)
  await page.goto(`/operator/agents/build/edit${dir}`)
  await expect(page.getByTestId("agent-model-now")).toHaveText(
    "Uses the default model: Claude Opus 4.6 · OpenCode (OpenCode decides)",
  )
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Provider"]')).toHaveCount(0)
  await page.getByLabel("Description", { exact: true }).fill("Builds things")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.agentWrites.length).toBe(1)
  expect(state.agentWrites[0].body).not.toHaveProperty("model")
})
