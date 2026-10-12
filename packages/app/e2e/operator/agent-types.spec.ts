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
    callable: false,
    usage: "",
    actions: [],
    roles: [],
  })
  await expect(page).toHaveURL(/\/operator\/agents\?.*helper=labeler&hns=opencode/)
})

test("a helper is made callable and declares actions; any tool but a read-only one is confirmed first", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByRole("group", { name: "Type", exact: true }).getByRole("button", { name: "Helper" }).click()
  await page.getByLabel("Name", { exact: true }).fill("archiver")
  await page.getByRole("textbox", { name: "Helper text" }).fill("Archive old sessions.")
  await page.getByRole("group", { name: "Callable by agents" }).locator('[data-slot="switch-control"]').click()
  await page.getByLabel("What to give it / what you get back", { exact: true }).fill("a date → what was archived")

  const add = page.locator(
    '[data-component="select-v2-root"][aria-label="Add an action…"] [data-component="select-v2"]',
  )
  // A read-only tool is added at once.
  await add.click()
  await page.getByRole("option", { name: "read", exact: true }).click()
  await expect(page.getByTestId("helper-actions")).toContainText("read")
  // A system action that changes things asks first; cancelled, it isn't added.
  await add.click()
  await page.getByRole("option", { name: "Archive a session" }).click()
  const dialog = page.getByRole("dialog").filter({ hasText: "unattended" })
  await expect(dialog).toContainText("This helper will run archive_session unattended")
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByTestId("helper-actions")).not.toContainText("Archive a session")
  await add.click()
  await page.getByRole("option", { name: "Archive a session" }).click()
  await page.getByRole("dialog").filter({ hasText: "unattended" }).getByRole("button", { name: "Allow it" }).click()
  await expect(page.getByTestId("helper-actions")).toContainText("Archive a session")

  await page.getByRole("button", { name: "Create helper" }).click()
  await expect.poll(() => state.helperWrites.length).toBe(1)
  expect(state.helperWrites[0]!.body).toMatchObject({
    name: "archiver",
    callable: true,
    usage: "a date → what was archived",
    actions: ["read", "archive_session"],
  })
})

test("helper settings keep runs for some days; a helper's runs are listed, each opening its session", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents${dir}`)
  await page.getByRole("button", { name: "Helper settings" }).click()
  const days = page.getByLabel("Keep runs for (days)", { exact: true })
  await expect(days).toHaveValue("30")
  await days.fill("14")
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click()
  await expect.poll(() => state.helperSettings.runDays).toBe(14)

  await page.goto(`/operator/agents${dir}&helper=sorter&hns=opencode&htab=runs`)
  const runs = page.getByRole("table", { name: "Runs" })
  const run = runs.getByRole("row").filter({ hasText: "Agent build" })
  await expect(run).toContainText("Done")
  await expect(run).toContainText("bug")
  await run.click()
  await expect(page).toHaveURL(/session=ses_helper_run/)
})

test("helpers' notes are in the Inbox, and can be dismissed", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/inbox")
  await page.getByRole("button", { name: "Notes (1)" }).click()
  const notes = page.getByRole("table", { name: "Notes from helpers" })
  await expect(notes).toContainText("Archived 3 sessions untouched for a year.")
  await expect(notes).toContainText("sorter · opencode")
  await notes.getByRole("button", { name: "Dismiss" }).click()
  await expect.poll(() => state.notes.length).toBe(0)
})

test("a helper takes over roles: each role's contract, a role moved from another helper, the OpenCode warning", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.helpers.find((item) => item.name === "sorter")!.roles = ["purpose-generator"]
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByRole("group", { name: "Type", exact: true }).getByRole("button", { name: "Helper" }).click()
  await page.getByLabel("Name", { exact: true }).fill("titler")
  await page.getByRole("textbox", { name: "Helper text" }).fill("One short title line.")

  const addRole = page.locator(
    '[data-component="select-v2-root"][aria-label="Take over a role…"] [data-component="select-v2"]',
  )
  await addRole.click()
  await page.getByRole("option", { name: "Title", exact: true }).click()
  await expect(page.getByTestId("role-contract-title")).toContainText("returns one title line")
  await expect(page.getByTestId("role-opencode-warning")).toContainText(
    "The OpenCode namespace then no longer matches upstream for Title.",
  )
  await addRole.click()
  await page.getByRole("option", { name: "Purpose generator" }).click()
  await expect(page.getByTestId("role-contract-purpose-generator")).toContainText(
    "sorter holds it now: saving moves it here.",
  )
  // A role helper has no actions.
  await expect(page.getByText("A helper that takes over a role has no actions")).toBeVisible()
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Add an action…"]')).toHaveCount(0)

  await page.getByRole("button", { name: "Create helper" }).click()
  await expect.poll(() => state.helperWrites.length).toBe(1)
  expect(state.helperWrites[0]!.body).toMatchObject({
    name: "titler",
    roles: ["title", "purpose-generator"],
    actions: [],
  })
})

test("a built-in helper a namespace's helper replaced says so", async ({ page }) => {
  const state = await mockOperator(page)
  state.helpers.find((item) => item.name === "purpose-generator")!.replacedBy = "sorter"
  await page.goto(`/operator/agents${dir}`)
  const table = page.getByRole("table", { name: "Agents" })
  await page.getByRole("searchbox", { name: "Search agents" }).fill("purpose")
  await expect(table.getByRole("row", { name: /^purpose-generator/ })).toContainText("Built in · replaced by sorter")
  await table.getByRole("row", { name: /^purpose-generator/ }).click()
  await expect(page.getByTestId("helper-replaced")).toContainText("In this namespace sorter does this job instead.")
})

test("a Dynamic layer of yours names the helper that writes it", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=layers")
  await page.locator('[data-section="dynamic"]').getByRole("button", { name: "New Dynamic layer" }).click()
  const overlay = page.getByRole("dialog")
  await overlay.getByLabel("Name", { exact: true }).fill("Today's focus")
  await overlay.getByLabel("Prompt", { exact: true }).fill("Say what to focus on today.")
  const writer = overlay.locator(
    '[data-component="select-v2-root"][aria-label="Written by"] [data-component="select-v2"]',
  )
  await expect(writer).toContainText("Default: OpenCode's Dynamic generator")
  await writer.click()
  await page.locator('[data-component="menu-v2-item"]').filter({ hasText: /^sorter$/ }).click()
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]!.body).toMatchObject({ prompt: "Say what to focus on today.", writer: "sorter" })
})
