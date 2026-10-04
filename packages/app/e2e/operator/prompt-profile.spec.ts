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

// Picks an option from the select inside the labelled field group.
const choose = async (page: Page, field: string, option: string) => {
  await page.getByRole("group", { name: field, exact: true }).locator('[data-component="select-v2"]').first().click()
  await page.getByRole("option", { name: option }).click()
}

// Switches the page's view with the dropdown in its header.
const view = async (page: Page, name: string) => {
  await page.locator('[data-component="operator-page-header"] [data-component="select-v2"]').click()
  await page.getByRole("option", { name }).click()
}

test("a goal, a role layer, a group and a profile reach a project agent's prompt", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/profile")
  await expect(page.getByLabel("Project", { exact: true })).toHaveCount(0)

  // 1. The project's goal.
  const purpose = page.locator('[data-section="purpose"]')
  await purpose.getByRole("row", { name: /smoke-project: no goal yet/ }).click()
  await expect(page.getByRole("heading", { name: "New project goal" })).toBeVisible()
  await page.getByLabel("Name", { exact: true }).fill("Release goal")
  await page.getByLabel("Text", { exact: true }).fill("Ship the release.")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.profileWrites.length).toBe(1)
  expect(state.profileWrites[0].body).toMatchObject({
    section: "purpose",
    purpose: "goal",
    projects: [directory],
    text: "Ship the release.",
  })
  await expect(purpose.getByRole("row", { name: /Release goal/ })).toBeVisible()

  // 2. A role layer.
  await page.locator('[data-section="role"]').getByRole("button", { name: "New layer" }).click()
  await page.getByLabel("Name", { exact: true }).fill("Reviewer")
  await page.getByLabel("Text", { exact: true }).fill("You review release notes.")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.profileWrites.length).toBe(2)
  expect(state.profileWrites[1].body).toMatchObject({ section: "role", projects: "*" })

  // 3. A group with it.
  await view(page, "Group Definition")
  await expect(page).toHaveURL(/view=groups/)
  await page.getByRole("button", { name: "New group" }).click()
  await page.getByLabel("Name", { exact: true }).fill("Release roles")
  await choose(page, "Layers", "Reviewer · Role")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.profileWrites.length).toBe(3)
  expect(state.profileWrites[2].body).toMatchObject({ type: "role", layers: ["reviewer"] })

  // 4 and 5. A profile with the group, the default for this project.
  await view(page, "Profile Definition")
  await page.getByRole("button", { name: "New profile" }).click()
  await page.getByLabel("Name", { exact: true }).fill("Release")
  await choose(page, "Role", "Release roles")
  await page.getByRole("group", { name: "Default for" }).getByText("smoke-project").click()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.profileWrites.length).toBe(5)
  expect(state.profileWrites[3].body).toMatchObject({
    name: "Release",
    groups: [
      "builtin.platform",
      "builtin.purpose",
      "release-roles",
      "builtin.identity",
      "builtin.capabilities",
      "builtin.environment",
      "builtin.instructions",
      "builtin.output",
    ],
  })
  expect(state.profileWrites[4]).toMatchObject({
    path: "/operator/prompt-profile/defaults",
    body: { projects: { [directory]: "release" } },
  })

  // 6. Both reach triage's prompt.
  await page.goto(`/operator/agents/triage?dir=${encodeURIComponent(directory)}&tab=prompt`)
  const sections = page.locator('[data-slot="operator-prompt-section"]')
  await expect(sections.nth(0)).toContainText("Ship the release.")
  await expect(sections.nth(0)).toContainText("Mandatory")
  await expect(sections.nth(1)).toContainText("You review release notes.")
  await expect(page.locator('[data-component="operator-facts"]')).toContainText("Release")
})

test("overrides sit under the text they replace, and Reset deletes one", async ({ page }) => {
  const state = await mockOperator(page)
  state.profile.layers.push({
    id: "terse",
    name: "Terse",
    section: "base",
    overrides: "base.default",
    projects: "*",
    priority: 50,
    enabled: true,
    text: "Be terse.",
    origin: "profile",
  })
  await page.goto("/operator/profile?view=layers")

  const base = page.locator('[data-section="base"]')
  await expect(base.getByRole("row", { name: /base\.default/ })).toBeVisible()
  await base.getByRole("row", { name: /Terse/ }).click()
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue("Be terse.")
  await page.getByRole("button", { name: "Reset" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Reset" }).click()
  await expect.poll(() => state.profileWrites.length).toBe(1)
  expect(state.profileWrites[0]).toMatchObject({ method: "DELETE", path: "/operator/prompt-profile/layer/terse" })

  await base.getByRole("row", { name: /base\.anthropic/ }).click()
  await expect(page.getByText("Not changed: OpenCode's own text is used everywhere.")).toBeVisible()
  await page.getByRole("button", { name: "Write your version" }).click()
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue("You are OpenCode, the best coding agent.")
})

test("built-in groups and profiles are read-only and can be duplicated", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/profile?view=groups&group=builtin.purpose")

  await expect(page.getByText("OpenCode's own group.")).toBeVisible()
  const layers = page.getByRole("list", { name: "Layers" })
  await expect(layers.getByRole("listitem")).toHaveCount(2)
  await expect(layers).toContainText("Org value")
  await expect(layers).toContainText("Mandatory")
  await page.getByRole("button", { name: "Duplicate" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Purpose copy")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.profileWrites.length).toBe(1)
  expect(state.profileWrites[0].body).toMatchObject({ type: "purpose", layers: ["purpose.org", "purpose.goal"] })

  await page.goto("/operator/profile?view=profiles&profile=helper")
  await expect(page.getByText("OpenCode's own profile.")).toBeVisible()
  await expect(page.getByLabel("Name", { exact: true })).toBeDisabled()
})
