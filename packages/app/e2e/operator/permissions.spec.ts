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

const addRule = async (page: Page, permission: string, pattern: string, action: string) => {
  const add = page.getByTestId("permission-add")
  // A permission field suggests known permissions (a list), so it is a combobox.
  await add.getByRole("combobox", { name: "New rule's permission" }).fill(permission)
  await add.getByRole("textbox", { name: "New rule's pattern" }).fill(pattern)
  await add
    .locator('[data-component="select-v2-root"][aria-label="New rule\'s action"] [data-component="select-v2"]')
    .click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${action}$`, "i") })
    .click()
  await add.getByRole("button", { name: "Add rule" }).click()
}

test("the Permissions tab shows where each rule comes from, and edits the agent's own rules in place", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=permissions`)
  const table = page.getByRole("table", { name: "Permissions" })
  await expect(table.getByRole("row", { name: /question/ })).toContainText("OpenCode default")
  await expect(table.getByRole("row", { name: /webfetch/ })).toContainText("Config permission")
  await expect(table.getByRole("row", { name: /external_directory/ })).toContainText("OpenCode truncation folder")

  await page.getByRole("button", { name: "Edit permissions" }).click()
  const editor = page.getByTestId("permission-editor")
  await expect(editor).toContainText("Checked from the bottom up: the last rule that matches wins.")
  await expect(editor).toContainText("The agent has no rules of its own.")
  await expect(page.getByTestId("agent-permissions-target")).toContainText(
    ".opencode/opencode.jsonc → agent.build.permission",
  )
  await expect(page.getByTestId("agent-permissions-edit")).toContainText("tracked by the project's git repository")
  // The overlay stays on this agent and section while editing.
  await expect(page.getByRole("tab", { name: "Overview" })).toBeDisabled()

  await addRule(page, "webfetch", "*", "Deny")
  const impact = page.getByTestId("permission-impact")
  await expect(impact.getByTestId("impact-tools")).toContainText("webfetch")
  await expect(impact.getByTestId("impact-tools")).toContainText("by rule #5")

  // A pattern-only change: no change to what is sent, and an absolute read pattern gets a hint.
  await addRule(page, "read", "~/*", "Allow")
  await expect(editor.getByTestId("rule-hint")).toContainText("This pattern is absolute")

  await page.getByRole("button", { name: "Save permissions" }).click()
  await expect.poll(() => state.permissionWrites.length).toBe(1)
  expect(state.permissionWrites[0]).toEqual({
    agent: "build",
    body: {
      scope: "project",
      rules: [
        { permission: "webfetch", pattern: "*", action: "deny" },
        { permission: "read", pattern: "~/*", action: "allow" },
      ],
    },
  })
  // Back to the list, now with the agent's own rules.
  await expect(page.getByRole("button", { name: "Edit permissions" })).toBeVisible()
  await expect(table.getByRole("row", { name: /~\/\*/ })).toContainText("Agent")
})

test("Override adds a rule that wins; a repeated pair and an order that grouping changes are caught", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=permissions`)
  await page.getByRole("button", { name: "Edit permissions" }).click()
  const editor = page.getByTestId("permission-editor")
  await editor
    .getByRole("row", { name: /webfetch/ })
    .getByRole("button", { name: "Override" })
    .click()
  await expect(editor.getByRole("combobox", { name: "Permission of rule 1" })).toHaveValue("webfetch")

  // The same pair again: the later one replaces the earlier one, and Save waits until it is removed.
  await addRule(page, "webfetch", "*", "Deny")
  await expect(page.getByTestId("permission-duplicates")).toContainText("the later one replaces the earlier one")
  await expect(page.getByRole("button", { name: "Save permissions" })).toBeDisabled()
  await page.getByRole("button", { name: "Remove the earlier one" }).click()
  await expect(page.getByTestId("permission-duplicates")).toHaveCount(0)

  // read *, then * *, then read *.md: saved grouped, read's rules come first, which changes results.
  await addRule(page, "read", "*", "Deny")
  await addRule(page, "*", "*", "Ask")
  await addRule(page, "read", "*.md", "Deny")
  await expect(page.getByTestId("permission-reorder")).toContainText("saved grouped by permission")
  await page.getByRole("button", { name: "Save permissions" }).click()
  await expect(page.getByRole("dialog").last()).toContainText("Save rules grouped by permission?")
  await page.getByRole("dialog").last().getByRole("button", { name: "Save anyway" }).click()
  await expect.poll(() => state.permissionWrites.length).toBe(1)
  expect(state.permissionWrites[0].body).toMatchObject({ confirmOrder: true })
})

test("Change access on a tool opens the Permissions editor filtered to its permission", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=tools`)
  await page.getByRole("table", { name: "Tools sent" }).getByRole("row", { name: /^read/ }).click()
  await page.getByTestId("tool-overlay").getByRole("button", { name: "Change access" }).click()
  await expect(page).toHaveURL(/atab=permissions/)
  await expect(page).toHaveURL(/aedit=1/)
  const editor = page.getByTestId("permission-editor")
  await expect(editor).toContainText("Showing the rules for read")
  await expect(editor.getByRole("row", { name: /question/ })).toBeHidden()
  await expect(editor.getByRole("row", { name: /\*\.env/ })).toBeVisible()
})

test("the Edit form shows the agent's full list, not only its own rules", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build/edit${dir}`)
  const editor = page.getByTestId("permission-editor")
  await expect(editor.getByRole("row", { name: /question/ })).toContainText("OpenCode default")
  await expect(editor.getByRole("row", { name: /webfetch/ })).toContainText("Config permission")
  await expect(editor).toContainText("The agent has no rules of its own.")
})
