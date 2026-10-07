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
  // The list just opened is the last one (one that is still closing may be there too).
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${action}$`, "i") })
    .last()
    .click()
  await expect(page.getByRole("listbox")).toHaveCount(0)
  await add.getByRole("button", { name: "Add rule" }).click()
}

// Picks an action in a select named `label`.
const choose = async (page: Page, label: string, action: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${action}$`, "i") })
    .last()
    .click()
  // The list closes before anything else opens.
  await expect(page.getByRole("listbox")).toHaveCount(0)
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

test("a rule from elsewhere is changed on its own line; a repeated pair is caught", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=permissions`)
  await page.getByRole("button", { name: "Edit permissions" }).click()
  const editor = page.getByTestId("permission-editor")
  const webfetch = editor.locator("tr[data-locked]", { hasText: "webfetch" })

  // The pencil opens the same line for a change; no line is added.
  await webfetch.getByRole("button", { name: "Change rule #4" }).click()
  await choose(page, "New action for rule #4", "Deny")
  await expect(webfetch).toContainText("Changed for this agent · was Ask (Config permission")
  await expect(webfetch).toContainText("Not saved")
  await expect(editor.locator("tr[data-editable]")).toHaveCount(0)
  await expect(editor.locator("tr", { hasText: "webfetch" })).toHaveCount(1)
  // Its number says where it is checked: with the agent's own rules, after the config's.
  await expect(webfetch.locator("td").nth(1)).toHaveText("5")

  // Undo: the line is the config's rule again.
  await webfetch.getByRole("button", { name: "Undo the change to rule #5" }).click()
  await expect(webfetch).toContainText("Config permission")
  await expect(webfetch.getByRole("button", { name: "Change rule #4" })).toBeVisible()

  // Changed again, then the same pair added below: the later one replaces the earlier one, which
  // becomes a line of its own, and Save waits until it is removed.
  await webfetch.getByRole("button", { name: "Change rule #4" }).click()
  await choose(page, "New action for rule #4", "Deny")
  await addRule(page, "webfetch", "*", "Allow")
  await expect(page.getByTestId("permission-duplicates")).toContainText("the later one replaces the earlier one")
  await expect(webfetch).toContainText("Allow")
  await expect(editor.locator("tr[data-editable]")).toContainText("Replaced by #6")
  await expect(page.getByRole("button", { name: "Save permissions" })).toBeDisabled()
  await page.getByRole("button", { name: "Remove the earlier one" }).click()
  await expect(page.getByTestId("permission-duplicates")).toHaveCount(0)
  await expect(editor.locator("tr[data-editable]")).toHaveCount(0)

  await page.getByRole("button", { name: "Save permissions" }).click()
  await expect.poll(() => state.permissionWrites.length).toBe(1)
  expect(state.permissionWrites[0].body.rules).toEqual([{ permission: "webfetch", pattern: "*", action: "allow" }])
  // Saved: the list shows the change on the config rule's line.
  const table = page.getByRole("table", { name: "Permissions" })
  await expect(table.getByRole("row", { name: /webfetch/ })).toHaveCount(1)
  await expect(table.getByRole("row", { name: /webfetch/ })).toContainText("was Ask (Config permission")
})

test("an order that grouping changes is caught", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=permissions`)
  await page.getByRole("button", { name: "Edit permissions" }).click()

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

test("a session's own rules: added on the Sessions page, saved with the session, and reset to its agent", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/sessions${dir}&session=ses_op_1&stab=permissions`)
  const panel = page.getByTestId("session-permissions")
  await expect(panel).toContainText("Same as the agent until you change it here.")
  await expect(panel.getByRole("row", { name: /question/ })).toContainText("OpenCode default")

  await addRule(page, "webfetch", "*", "Deny")
  await expect(panel.getByTestId("impact-tools")).toContainText("webfetch")
  await panel.getByRole("button", { name: "Save session rules" }).click()
  await expect.poll(() => state.sessionPermissionWrites.length).toBe(1)
  expect(state.sessionPermissionWrites[0]).toEqual({
    sessionID: "ses_op_1",
    body: { rules: [{ permission: "webfetch", pattern: "*", action: "deny" }] },
  })
  await expect(panel.getByRole("row", { name: /webfetch \* /i }).last()).toContainText("Session · set by you")

  await panel.getByRole("button", { name: "Reset to agent" }).click()
  await page.getByRole("dialog").last().getByRole("button", { name: "Reset to agent" }).click()
  await expect.poll(() => state.sessionPermissionWrites.length).toBe(2)
  expect(state.sessionPermissionWrites[1].body).toEqual({ rules: [] })
  await expect(panel).toContainText("Same as the agent until you change it here.")
})

test("Change access on a session's tool prompt opens that session's rules", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=tools`)
  await page.getByTestId("tool-prompt-runs-as").getByRole("button", { name: "In a session…" }).click()
  await page.getByRole("table", { name: "Tools sent" }).getByRole("row", { name: /^read/ }).click()
  await page.getByTestId("tool-overlay").getByRole("button", { name: "Change access" }).click()
  await expect(page).toHaveURL(/\/operator\/sessions\?session=ses_op_1&stab=permissions&sperm=read/)
  await expect(page.getByTestId("session-permissions")).toContainText("Showing the rules for read")
})

test("Always in the inbox adds the rule to that session's own rules", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/inbox")
  await page.getByRole("button", { name: "Always" }).first().click()
  await page.goto(`/operator/sessions${dir}&session=ses_op_1&stab=permissions`)
  const panel = page.getByTestId("session-permissions")
  await expect(panel.getByRole("row", { name: /git push \*/ })).toContainText("Session · Always allow")
})
