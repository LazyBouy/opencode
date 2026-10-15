import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// The agent form's text edits (agent_form_spec.md §6.3–§6.4): "System Prompt as sent" starts locked; unlocked, the
// agent's prompt is written in its block, and with Override on an edited block becomes a copy of the agent's own and
// text added between blocks new text of the agent's own. Locked blocks stay locked. Nothing is written into the
// namespace: the texts are saved in the agent's prompt setting.

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
type Override = { slots?: Record<string, string[]>; layers?: Record<string, unknown> }
const P = "opencode:"

test("the form's text edits are this agent's own: copies, added text, locked blocks, Reset", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.items.opencode!.layers.push({
    id: "reviewer",
    name: "Reviewer",
    type: "role",
    section: "role",
    origin: "user",
    text: "You review.",
  })
  state.prompt.items.opencode!.profiles.push({
    id: "reviewing",
    name: "Reviewing",
    group: `${P}group.opencode`,
    slots: {
      role: ["reviewer"],
      identity: [],
      dynamic: [`${P}slot.agent`, `${P}generated.environment`],
      output: [],
    },
    builtin: false,
  })
  const override = () => (state.prompt.drafts.at(-1)?.draft.setting as { override?: Override })?.override
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("scribe")
  await select(page, "Profile").click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^Reviewing/ })
    .click()
  await page.getByText("Override", { exact: true }).click()

  const sent = page.getByTestId("prompt-as-sent")
  const block = (name: string) => sent.getByTestId("prompt-block").filter({ hasText: name })
  await expect(block("Reviewer")).toContainText("You review.")
  // Locked: nothing can be typed. Environment is filled in per request.
  await expect(sent.locator("textarea")).toHaveCount(0)
  await expect(block("Environment").getByTestId("prompt-block-locked")).toHaveText("Locked: filled in per request")

  await page.getByTestId("prompt-as-sent").getByText("Locked", { exact: true }).click()
  await expect(block("Environment").locator("textarea")).toHaveCount(0)
  // The agent's prompt, in its (empty) block.
  await sent.locator("[data-agent-prompt] textarea").fill("Write things down.")
  await expect.poll(() => state.prompt.drafts.at(-1)?.draft.prompt).toBe("Write things down.")

  // An edited layer: a copy of the agent's own in its place.
  await block("Reviewer").locator("textarea").fill("You review, briefly.")
  await expect.poll(override).toEqual({
    slots: { role: ["agent:1"] },
    layers: { "1": { type: "role", text: "You review, briefly.", basedOn: "reviewer" } },
  })
  await expect(block("Reviewer (this agent)").getByTestId("prompt-block-changed")).toHaveText(
    "Changed (this agent only)",
  )

  // Text added after it: Agent role (the group above) or Agent identity (empty, between it and Dynamic).
  await sent.getByTestId("prompt-add-text").nth(1).click()
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Add to"]')).toContainText("Agent role")
  await page.getByLabel("New text", { exact: true }).fill("Cite the PR.")
  await sent.getByRole("button", { name: "Add", exact: true }).click()
  await expect.poll(override).toEqual({
    slots: { role: ["agent:1", "agent:2"] },
    layers: {
      "1": { type: "role", text: "You review, briefly.", basedOn: "reviewer" },
      "2": { type: "role", text: "Cite the PR." },
    },
  })
  await expect(block("Text (this agent)").locator("textarea")).toHaveValue("Cite the PR.")
  // The Override slot editor names them.
  await expect(page.locator('[data-slot="operator-slot"][data-type="role"]')).toContainText("Reviewer (this agent)")

  // Locked again: nothing to type in, the edits kept.
  await page.getByTestId("prompt-as-sent").getByText("Locked", { exact: true }).click()
  await expect(sent.locator("textarea")).toHaveCount(0)
  await expect(block("Reviewer (this agent)")).toContainText("You review, briefly.")

  // Reset block: the profile's Reviewer back in its place.
  await block("Reviewer (this agent)").getByRole("button", { name: "Reset block" }).click()
  await expect
    .poll(override)
    .toEqual({ slots: { role: ["reviewer", "agent:2"] }, layers: { "2": { type: "role", text: "Cite the PR." } } })
  await expect(block("Reviewer")).toContainText("You review.")

  // Saved with the agent: its prompt and its own texts, and nothing written into the namespace.
  await page.getByRole("button", { name: "Create agent" }).click()
  await expect.poll(() => state.prompt.writes.at(-1)?.path).toMatch(/\/operator\/agent-prompt\/scribe$/)
  expect(state.prompt.writes.at(-1)!.body).toEqual({
    profile: "reviewing",
    override: { slots: { role: ["reviewer", "agent:2"] }, layers: { "2": { type: "role", text: "Cite the PR." } } },
  })
  expect(state.prompt.writes.filter((write) => !write.path.includes("/operator/agent-prompt/"))).toEqual([])
  expect((state.agentWrites.at(-1)!.body as { prompt?: string }).prompt).toBe("Write things down.")
})

test("Reset all overrides clears the agent's changes after a question", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.items.opencode!.layers.push({
    id: "reviewer",
    name: "Reviewer",
    type: "role",
    section: "role",
    origin: "user",
    text: "You review.",
  })
  state.prompt.items.opencode!.profiles.push({
    id: "reviewing",
    name: "Reviewing",
    group: `${P}group.opencode`,
    slots: { role: ["reviewer"], identity: [], dynamic: [`${P}slot.agent`], output: [] },
    builtin: false,
  })
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("scribe")
  await select(page, "Profile").click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^Reviewing/ })
    .click()
  await page.getByText("Override", { exact: true }).click()
  // Override is on in the preview before the text is changed.
  await expect.poll(() => (state.prompt.drafts.at(-1)?.draft.setting as { override?: Override })?.override).toEqual({})
  await page.getByTestId("prompt-as-sent").getByText("Locked", { exact: true }).click()
  const sent = page.getByTestId("prompt-as-sent")
  // Dispatched on the button itself: the form's sections above still settle under load and can move it mid-click.
  await sent
    .getByTestId("prompt-block")
    .filter({ hasText: "Reviewer" })
    .getByRole("button", { name: "Remove block" })
    .dispatchEvent("click")
  await expect
    .poll(() => (state.prompt.drafts.at(-1)?.draft.setting as { override?: Override })?.override)
    .toEqual({ slots: { role: [] } })

  await page.getByRole("button", { name: "Reset all overrides" }).click()
  const question = page.getByRole("dialog").filter({ hasText: "Reset all overrides?" })
  await question.getByRole("button", { name: "Reset all overrides" }).click()
  await expect.poll(() => (state.prompt.drafts.at(-1)?.draft.setting as { override?: Override })?.override).toEqual({})
  await expect(sent.getByTestId("prompt-block").filter({ hasText: "Reviewer" }).locator("textarea")).toHaveValue(
    "You review.",
  )
})

test("leaving the form with unsaved changes asks first", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents${dir}`)
  await page.getByRole("button", { name: "New agent" }).click()
  await expect(page).toHaveURL(/\/operator\/agents\/new\?dir=/)
  await page.getByLabel("Name", { exact: true }).fill("scribe")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  const question = page.getByRole("dialog").filter({ hasText: "Discard your changes?" })
  await question.getByRole("button", { name: "Cancel" }).click()
  await expect(page).toHaveURL(/\/operator\/agents\/new\?dir=/)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await question.getByRole("button", { name: "Discard" }).click()
  await expect(page).not.toHaveURL(/\/operator\/agents\/new/)
})
