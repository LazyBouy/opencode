import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// The agent form's prompt (agent_form_spec.md §6.1–§6.2): a profile, Override once one is chosen, and "System Prompt
// as sent" built from the form's unsaved values, with counters for the whole prompt and a chosen block.

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

const dir = `?dir=${encodeURIComponent(directory)}`
const select = (page: Page, label: string) =>
  page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`)

test("a new agent's System Prompt as sent follows the form; Override waits for a profile", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("scribe")
  await expect(select(page, "Profile")).toContainText("Use the default")

  // Built from the form, not saved: its own prompt text where the profile puts it.
  const sent = page.getByTestId("prompt-as-sent")
  await expect(sent).toHaveAttribute("open", "")
  // The agent's own prompt is written in its block, once the text is unlocked.
  await expect(sent.locator("textarea")).toHaveCount(0)
  await page.getByTestId("prompt-as-sent").getByText("Locked", { exact: true }).click()
  await sent.locator("[data-agent-prompt] textarea").fill("Write things down clearly.")
  await expect.poll(() => state.prompt.drafts.at(-1)?.draft.prompt).toBe("Write things down clearly.")
  expect(state.prompt.drafts.at(-1)!.agent).toBe("scribe")
  await expect(sent.getByTestId("prompt-block").first()).toBeVisible()
  await expect(page.getByTestId("prompt-as-sent-counters")).toContainText("Whole prompt:")
  await sent.getByTestId("prompt-block").first().click()
  await expect(page.getByTestId("prompt-block-counters")).toBeVisible()

  // Override needs a profile.
  await expect(page.getByTestId("override-disabled")).toHaveText("Choose a profile to override it for this agent.")
  await select(page, "Profile").click()
  await page.locator('[data-component="menu-v2-item"]').filter({ hasText: /^Spec/ }).first().click()
  await expect(page.getByTestId("override-disabled")).toHaveCount(0)
  await expect
    .poll(() => (state.prompt.drafts.at(-1)?.draft.setting as { profile?: string })?.profile)
    .toBe("opencode:profile.spec")

  await page.getByRole("button", { name: "Create agent" }).click()
  await expect.poll(() => state.prompt.writes.at(-1)?.path).toMatch(/\/operator\/agent-prompt\/scribe$/)
  expect(state.prompt.writes.at(-1)!.body).toEqual({ profile: "opencode:profile.spec" })
})
