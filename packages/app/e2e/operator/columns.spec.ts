import { expect, test } from "@playwright/test"
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

test("a list's optional columns can be removed and added back; required ones cannot", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.items.opencode!.profiles.push({
    id: "release",
    name: "Release",
    group: "opencode:group.spec",
    slots: {},
    builtin: false,
  })
  state.prompt.agents[`${directory}\nreviewer`] = { profile: "release" }
  await page.goto(`/operator/agents${dir}`)

  const table = page.getByRole("table", { name: "Agents" })
  await expect(table.getByRole("columnheader", { name: "Profile" })).toBeVisible()
  await expect(table.getByRole("row", { name: /^build/ })).toContainText("OpenCode")
  await expect(table.getByRole("row", { name: /^reviewer/ })).toContainText("Release · agent setting")

  await table.getByRole("button", { name: "Columns of Agents" }).click()
  const menu = page.getByRole("menu")
  await expect(menu.getByRole("menuitemcheckbox", { name: "Name" })).toHaveCount(0)
  await menu.getByRole("menuitemcheckbox", { name: "Profile" }).click()
  await page.keyboard.press("Escape")
  await expect(table.getByRole("columnheader", { name: "Profile" })).toHaveCount(0)
  await expect(table.getByRole("columnheader", { name: "Name" })).toBeVisible()

  // The choice is kept.
  await page.reload()
  await expect(table.getByRole("columnheader", { name: "Model" })).toBeVisible()
  await expect(table.getByRole("columnheader", { name: "Profile" })).toHaveCount(0)
  await table.getByRole("button", { name: "Columns of Agents" }).click()
  await page.getByRole("menu").getByRole("menuitemcheckbox", { name: "Profile" }).click()
  await page.keyboard.press("Escape")
  await expect(table.getByRole("columnheader", { name: "Profile" })).toBeVisible()
})

test("the agent's Overview shows its profile and its model with where each comes from; each (i) is beside its label", async ({
  page,
}) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}`)
  const facts = page.locator('[data-component="operator-facts"]')
  await expect(facts).toContainText("OpenCode (from: namespace default)")
  // No model of its own: the project's default model, and where it comes from (default_models_spec.md §7).
  await expect(facts.getByTestId("agent-model")).toContainText("Default model · Claude Opus 4.6 · OpenCode")
  await expect(facts.getByTestId("agent-model")).toContainText("OpenCode decides")
  // The label and its (i) share a line; the value is below.
  const label = facts.locator("dt").first()
  const help = label.getByRole("button", { name: /^About / })
  const value = facts.locator("dd").first()
  const [labelBox, helpBox, valueBox] = await Promise.all([
    label.boundingBox(),
    help.boundingBox(),
    value.boundingBox(),
  ])
  expect(Math.abs(helpBox!.y + helpBox!.height / 2 - (labelBox!.y + labelBox!.height / 2))).toBeLessThan(4)
  expect(valueBox!.y).toBeGreaterThan(labelBox!.y + labelBox!.height - 1)
})

test("an agent whose own model is not available says so, and which model stands in", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/triage${dir}`)
  await expect(page.getByRole("dialog").getByTestId("model-source")).toContainText(
    "the agent's own model opencode/gpt-6-luna",
  )
})

test("a helper agent's Overview shows the helper profile", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/title${dir}`)
  await expect(page.locator('[data-component="operator-facts"]')).toContainText("Title (from: helper)")
})

test("Profile Definition has no Used by column", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/profile?tab=profiles")
  const table = page.getByRole("table", { name: "Profiles" })
  await expect(table.getByRole("columnheader", { name: "Name", exact: true })).toBeVisible()
  await expect(table.getByRole("columnheader", { name: "Used by" })).toHaveCount(0)
})
