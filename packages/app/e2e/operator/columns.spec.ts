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

test("the agent's Overview shows its profile and where it comes from", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}`)
  await expect(page.locator('[data-component="operator-facts"]')).toContainText("OpenCode (from: namespace default)")
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
