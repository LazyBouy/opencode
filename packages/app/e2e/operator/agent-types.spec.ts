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

test("the Agents page lists the namespace's helpers; one opens in its overlay, its text edited in place", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents${dir}`)
  const table = page.getByRole("table", { name: "Agents" })
  await expect(table.getByRole("row", { name: /^sorter/ })).toContainText("Helper")
  await expect(table.getByRole("row", { name: /^title/ })).toContainText("Built in")
  await page
    .locator('[data-component="select-v2-root"][aria-label="Filter by type"] [data-component="select-v2"]')
    .click()
  await page.getByRole("option", { name: "Helper", exact: true }).click()
  await expect(table.getByRole("row", { name: /^build/ })).toHaveCount(0)
  await expect(table.getByRole("row", { name: /^compaction/ })).toContainText("The chat's model")

  await table.getByRole("row", { name: /^sorter/ }).click()
  await expect(page).toHaveURL(/helper=sorter&hns=opencode/)
  await expect(page.getByTestId("helper-model")).toContainText("Small model")
  await expect(page.getByText("120 s")).toBeVisible()

  await page.getByRole("dialog").getByRole("tab", { name: "Text" }).click()
  const text = page.getByRole("textbox", { name: "Helper text" })
  await expect(text).toHaveValue("Sort the issue.")
  await expect(page.getByTestId("text-counters")).toContainText("15 characters · 3 words · ≈4 tokens")
  await text.fill("Label it.")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.helperWrites.length).toBe(1)
  expect(state.helperWrites[0]).toMatchObject({ method: "PATCH", body: { text: "Label it." } })
  expect(state.helperWrites[0]!.url).toContain("/operator/helper/opencode/sorter")
})

test("New agent → Type: Helper creates a namespace helper, on the small model by default", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByRole("group", { name: "Type", exact: true }).getByRole("button", { name: "Helper" }).click()
  // Namespace replaces Save in; the agent's own fields are gone.
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Namespace"]')).toContainText("OpenCode")
  await expect(page.getByRole("group", { name: "Save in", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Small model" })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("button", { name: "Add trigger" })).toBeDisabled()

  await page.getByLabel("Name", { exact: true }).fill("labeler")
  await page.getByLabel("Description", { exact: true }).fill("Labels issues")
  await page.getByRole("textbox", { name: "Helper text" }).fill("Label the issue.")
  await page.getByRole("button", { name: "Create helper" }).click()

  await expect.poll(() => state.helperWrites.length).toBe(1)
  expect(state.helperWrites[0]!.url).toContain("/operator/helper/opencode")
  expect(state.helperWrites[0]!.body).toEqual({
    name: "labeler",
    description: "Labels issues",
    model: { source: "small" },
    text: "Label the issue.",
    steps: 5,
    timeout: 120,
  })
  await expect(page).toHaveURL(/\/operator\/agents\?.*helper=labeler&hns=opencode/)
})
