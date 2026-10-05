import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

const dir = `?dir=${encodeURIComponent(directory)}`

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

const pick = async (page: Page, label: string, option: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

const user = (id: string, name: string, type: string, text: string) => ({
  id,
  name,
  type,
  section: type === "purpose" ? "purpose" : "identity",
  text,
  origin: "user",
})

test("the Prompt tab shows the profile, where it comes from, and every section with its source", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=prompt`)

  const facts = page.locator('[data-component="operator-facts"]')
  await expect(facts).toContainText("OpenCode")
  await expect(facts).toContainText("OpenCode (from: namespace default)")
  await expect(page.getByRole("group", { name: "Folder" })).toHaveCount(0)
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Profile"]')).toContainText(
    "Use the default (OpenCode)",
  )

  const sections = page.locator('[data-slot="operator-prompt-section"]')
  await expect(sections).toHaveCount(4)
  await expect(sections.nth(0)).toContainText("Agent identity")
  await expect(sections.nth(0)).toContainText("You are opencode, an interactive CLI tool.")
  await expect(sections.nth(1)).toContainText("Environment")
  await expect(sections.nth(2)).toContainText("SmokeProject/AGENTS.md")
  await expect(sections.nth(3)).toContainText("<available_skills>")

  await page.getByText("Exactly as sent (1 system messages)").click()
  await expect(page.locator('[data-slot="operator-details"] [data-component="operator-code"]')).toContainText(
    "You are opencode, an interactive CLI tool.\nYou are powered by",
  )

  await sections.nth(0).getByRole("button", { name: "Edit" }).click()
  await expect(page).toHaveURL(/\/operator\/profile\?ns=opencode&tab=layers&layer=opencode(:|%3A)base\.default/)
  await expect(page.getByRole("button", { name: "Make editable copy" })).toBeVisible()
})

test("an agent picks a profile, overrides one slot, and the preview shows purpose, the override and the rest", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.prompt.namespaces[0]!.purpose = "We make editors."
  state.prompt.items.opencode!.layers.push(
    user("goal", "Release goal", "purpose", "Ship the release."),
    user("reviewer", "Reviewer", "role", "You review release notes."),
    user("voice", "Voice", "identity", "Speak plainly."),
    user("strict", "Strict", "identity", "Be strict."),
  )
  state.prompt.items.opencode!.profiles.push({
    id: "release",
    name: "Release",
    group: "opencode:group.spec",
    slots: { role: ["reviewer"], identity: ["voice"], additional: ["opencode:generated.environment"] },
    builtin: false,
  })
  state.prompt.projects[directory] = { namespace: "opencode", purpose: "goal" }
  await page.goto(`/operator/agents/build${dir}&tab=prompt`)

  await pick(page, "Profile", "Release")
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]).toMatchObject({ method: "PUT", body: { profile: "release" } })
  await expect(page.locator('[data-component="operator-facts"]')).toContainText("Release (from: agent setting)")

  await page.getByText("Override", { exact: true }).click()
  const identity = page.getByRole("list", { name: "Agent identity" })
  await expect(identity).toContainText("Voice")
  await pick(page, "Add a layer to Agent identity", "Strict")
  await identity.getByRole("button", { name: "Move Strict up" }).click()
  const slot = page.locator('[data-slot="operator-slot"][data-type="identity"]')
  await expect(slot).toContainText("Changed")
  await expect(page.locator('[data-slot="operator-slot"][data-type="role"]')).not.toContainText("Changed")
  await page.getByRole("button", { name: "Save override" }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(2)
  expect(state.prompt.writes[1]!.body).toEqual({
    profile: "release",
    override: { slots: { identity: ["strict", "voice"] } },
  })

  const sections = page.locator('[data-slot="operator-prompt-section"]')
  await expect(sections.nth(0)).toContainText("We make editors.")
  await expect(sections.nth(0)).toContainText("Automatic")
  await expect(sections.nth(1)).toContainText("Ship the release.")
  await expect(sections.nth(2)).toContainText("You review release notes.")
  await expect(sections.nth(2)).not.toContainText("Changed")
  await expect(sections.nth(3)).toContainText("Be strict.")
  await expect(sections.nth(3)).toContainText("Changed")
  await expect(sections.nth(4)).toContainText("Speak plainly.")
  await expect(sections.nth(5)).toContainText("Environment")

  // Reset the slot: the agent follows the profile there again, and the override is removed.
  await slot.getByRole("button", { name: "Reset slot" }).click()
  await expect(slot).not.toContainText("Changed")
  await page.getByRole("button", { name: "Save override" }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(3)
  expect(state.prompt.writes[2]!.body).toEqual({ profile: "release", override: {} })
})

test("unticking Override asks first, and Preview on an agent previews another profile", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.items.opencode!.layers.push(user("strict", "Strict", "identity", "Be strict."))
  state.prompt.agents[`${directory}\nbuild`] = { override: { slots: { identity: ["strict"] } } }
  await page.goto(`/operator/agents/build${dir}&tab=prompt&previewProfile=opencode:profile.spec`)

  await expect(page.getByText("Previewing the profile Spec. It is not saved.")).toBeVisible()
  const sections = page.locator('[data-slot="operator-prompt-section"]')
  await expect(sections.first()).toContainText("You are opencode, an interactive CLI tool.")
  await expect(page.locator('[data-slot="operator-prompt-section"][data-changed]')).toHaveCount(0)
  await page.getByRole("button", { name: "Stop previewing" }).click()
  await expect(page).not.toHaveURL(/previewProfile/)
  await expect(sections.first()).toContainText("Be strict.")
  await expect(sections.first()).toContainText("Changed")

  await page.getByText("Override", { exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("Remove this agent's override?")
  await page.getByRole("dialog").getByRole("button", { name: "Remove override" }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]!.body).toEqual({})
})
