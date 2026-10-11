import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { modelProviders } from "./mock-models"
import { mockOperator } from "./mock-operator"

// A new chat's model (default_models_spec.md §9): the agent's own model, else the project's default model as the
// server resolves it; the app's own recent models (a previous chat's model) no longer win over it.

test("a new chat with an agent without a model starts on the project's default, not the last chat's model", async ({
  page,
}) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: modelProviders,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  const state = await mockOperator(page)
  state.models.projects[fixture.directory] = { namespace: "opencode", model: "openai/gpt-5", own: true }
  // The last chat ran on Claude Sonnet 4.5: the app's recent models start with it.
  await page.addInitScript(() => {
    localStorage.setItem(
      "opencode.global.dat:model",
      JSON.stringify({ user: [], recent: [{ providerID: "anthropic", modelID: "claude-sonnet-4-5" }], variant: {} }),
    )
  })
  await page.goto(`/${base64Encode(fixture.directory)}/session`)
  await expect(page.locator('[data-action="prompt-model"]').first()).toContainText("GPT-5")
})
