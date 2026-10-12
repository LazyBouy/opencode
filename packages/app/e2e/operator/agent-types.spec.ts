import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// An agent's Type and a subagent's Flavor (agent_types_spec.md §2, §3, §5).

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

test("the Agents page shows each agent's Type and filters by it", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents${dir}`)
  const table = page.getByRole("table", { name: "Agents" })
  await expect(table.getByRole("columnheader", { name: "Type" })).toBeVisible()
  await expect(table.getByRole("row", { name: /^build/ })).toContainText("Usual")
  await expect(table.getByRole("row", { name: /^reviewer/ })).toContainText("Subagent · incognito")

  await page
    .locator('[data-component="select-v2-root"][aria-label="Filter by type"] [data-component="select-v2"]')
    .click()
  await page.getByRole("option", { name: "Subagent · incognito" }).click()
  await expect(table.getByRole("row", { name: /^reviewer/ })).toBeVisible()
  await expect(table.getByRole("row", { name: /^build/ })).toHaveCount(0)
})

test("a new subagent is incognito unless made retentive; a Usual agent has no Flavor", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("scout")
  const type = page.getByRole("group", { name: "Type", exact: true })
  const flavor = page.getByRole("group", { name: "Flavor", exact: true })
  // A new agent is Usual + subagent: it has a Flavor, incognito by default.
  await expect(type.getByRole("button", { name: "Usual + subagent" })).toHaveAttribute("aria-pressed", "true")
  await expect(flavor.getByRole("button", { name: "Incognito" })).toHaveAttribute("aria-pressed", "true")
  await page.getByRole("button", { name: "About Flavor" }).hover()
  await expect(page.getByRole("tooltip")).toContainText("has no agent memory, and stores nothing")

  await type.getByRole("button", { name: "Usual", exact: true }).click()
  await expect(flavor).toHaveCount(0)
  await type.getByRole("button", { name: "Subagent", exact: true }).click()
  await flavor.getByRole("button", { name: "Retentive" }).click()
  await page.getByRole("button", { name: "Create agent" }).click()

  await expect.poll(() => state.agentWrites.length).toBe(1)
  expect(state.agentWrites[0].body).toMatchObject({ name: "scout", mode: "subagent", subagentMemory: "retentive" })
})
