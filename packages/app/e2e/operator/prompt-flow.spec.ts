import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

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

// Picks an option from the select with this accessible name. Inside a modal dialog the list is not
// in the accessibility tree, so options are found by their items there.
const pick = async (page: Page, label: string, option: string, inDialog = false) => {
  await (inDialog ? page.getByRole("dialog") : page)
    .locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`)
    .click()
  if (!inDialog) return page.getByRole("option", { name: option, exact: true }).click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${option}$`) })
    .click()
}

// Records open in the overlay: Save there, then close it.
const saveAndClose = async (page: Page, name: string) => {
  const overlay = page.getByRole("dialog")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect(overlay.getByRole("heading", { name, exact: true })).toBeVisible()
  await overlay.getByRole("button", { name: "Close" }).click()
  await expect(overlay).toBeHidden()
}

// A layer in a Layer Definition section.
const layer = async (page: Page, section: string, button: string, name: string, text: string) => {
  await page.locator(`[data-section="${section}"]`).getByRole("button", { name: button }).click()
  const overlay = page.getByRole("dialog")
  await overlay.getByLabel("Name", { exact: true }).fill(name)
  await overlay.getByLabel("Text", { exact: true }).fill(text)
  await saveAndClose(page, name)
  await expect(page.locator(`[data-section="${section}"]`).getByRole("row", { name: new RegExp(name) })).toBeVisible()
}

test("a namespace, a moved project, a custom type and group, a profile, a project default and an override reach the preview", async ({
  page,
}) => {
  const state = await mockOperator(page)

  // 1. A namespace with an org purpose, in Settings.
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Namespaces" }).click()
  await settings.getByRole("button", { name: "New namespace" }).click()
  await settings.getByLabel("Name", { exact: true }).fill("Acme")
  await settings.getByLabel("Org purpose", { exact: true }).fill("We build developer tools.")
  await settings.getByRole("button", { name: "Create namespace" }).click()
  await expect.poll(() => state.prompt.namespaces.map((item) => item.id)).toContain("acme")
  await page.keyboard.press("Escape")
  await expect(settings).toBeHidden()

  // 2. The project moves to it.
  await page.goto("/operator/projects")
  const row = page.getByRole("row", { name: /smoke-project/ })
  await row.getByRole("button", { name: "Prompt settings of smoke-project" }).click()
  const dialog = page.getByRole("dialog")
  await pick(page, "Namespace", "Acme", true)
  await dialog.getByRole("button", { name: "Check the move" }).click()
  await dialog.getByRole("button", { name: "Move", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(row).toContainText("Acme")

  // 3. A Project Purpose, layers, a custom group type and a group using it.
  await page.goto("/operator/profile?ns=acme")
  await layer(page, "purpose", "New Project Purpose", "Ship CLI", "Ship the CLI.")
  await layer(page, "role", "New layer", "Reviewer", "You review.")
  await layer(page, "identity", "New layer", "Voice", "Speak plainly.")
  await layer(page, "identity", "New layer", "Rules", "Use Bun.")
  await page.getByRole("tab", { name: "Group Definition" }).click()
  await page.getByRole("button", { name: "New type" }).click()
  const overlay = page.getByRole("dialog")
  await overlay.getByLabel("Name", { exact: true }).fill("Compliance")
  await saveAndClose(page, "Compliance")
  await expect(page.getByRole("table", { name: "Group types" })).toContainText("Compliance")
  await page.getByRole("button", { name: "New group" }).click()
  await overlay.getByLabel("Name", { exact: true }).fill("Acme order")
  await pick(page, "Add a type", "Compliance", true)
  await saveAndClose(page, "Acme order")
  await expect(page.getByRole("table", { name: "Groups" })).toContainText("Acme order")

  // 4. A profile with layers in two slots, reordered, and a layer created in the custom slot.
  await page.getByRole("tab", { name: "Profile Definition" }).click()
  await page.getByRole("button", { name: "New profile" }).click()
  await overlay.getByLabel("Name", { exact: true }).fill("Acme")
  await pick(page, "Group", "Acme order", true)
  await pick(page, "Add a layer to Agent role", "Reviewer", true)
  await pick(page, "Add a layer to Agent identity", "Voice", true)
  await pick(page, "Add a layer to Agent identity", "Rules", true)
  await overlay.getByRole("list", { name: "Agent identity" }).getByRole("button", { name: "Move Rules up" }).click()
  const compliance = overlay.locator('[data-slot="operator-slot"][data-type="compliance"]')
  await compliance.getByRole("button", { name: "Create layer" }).click()
  await compliance.getByLabel("Name", { exact: true }).fill("Legal")
  await compliance.getByLabel("Text", { exact: true }).fill("Follow the licence rules.")
  await compliance.getByRole("button", { name: "Create and add" }).click()
  await expect(overlay.getByRole("list", { name: "Compliance" })).toContainText("Legal")
  await saveAndClose(page, "Acme")
  await expect.poll(() => state.prompt.items.acme?.profiles.map((item) => item.name)).toContain("Acme")
  expect(state.prompt.items.acme!.profiles[0]).toMatchObject({
    group: "acme-order",
    slots: { role: ["reviewer"], identity: ["rules", "voice"], compliance: ["legal"] },
  })

  // 5. The project's default profile and Project Purpose.
  await page.goto("/operator/projects")
  await row.getByRole("button", { name: "Prompt settings of smoke-project" }).click()
  await pick(page, "Project Purpose", "Ship CLI", true)
  await pick(page, "Default profile", "Acme", true)
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(row).toContainText("Ship CLI")

  // 6. build overrides one slot: Agent identity without Voice.
  await page.goto(`/operator/agents/build?dir=${encodeURIComponent(directory)}&tab=prompt`)
  const facts = page.locator('[data-component="operator-facts"]')
  await expect(facts).toContainText("Acme")
  await expect(facts).toContainText("Acme (from: project default)")
  await page.getByText("Override", { exact: true }).click()
  await page.getByRole("list", { name: "Agent identity" }).getByRole("button", { name: "Take Voice out" }).click()
  await page.getByRole("button", { name: "Save override" }).click()
  await expect
    .poll(() => state.prompt.agents[`${directory}\nbuild`])
    .toEqual({
      override: { slots: { identity: ["rules"] } },
    })

  // 7. The preview: the org purpose and the project purpose, then the profile with the override.
  const sections = page.locator('[data-slot="operator-prompt-section"]')
  await expect(sections).toHaveCount(5)
  await expect(sections.nth(0)).toContainText("We build developer tools.")
  await expect(sections.nth(0)).toContainText("Automatic")
  await expect(sections.nth(1)).toContainText("Ship the CLI.")
  await expect(sections.nth(2)).toContainText("Agent role")
  await expect(sections.nth(2)).toContainText("You review.")
  await expect(sections.nth(3)).toContainText("Use Bun.")
  await expect(sections.nth(3)).toContainText("Changed")
  await expect(sections.nth(4)).toContainText("Compliance")
  await expect(sections.nth(4)).toContainText("Follow the licence rules.")
  await expect(page.locator('[data-slot="operator-prompt-section"]', { hasText: "Speak plainly." })).toHaveCount(0)
})
