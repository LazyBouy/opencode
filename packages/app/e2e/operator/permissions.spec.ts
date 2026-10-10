import { expect, type Locator, type Page, test } from "@playwright/test"
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

// Opens a select and picks an option from its own list (another one may still be closing).
const pick = async (page: Page, trigger: Locator, action: string) => {
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  const list = await trigger.getAttribute("aria-controls")
  await page
    .locator(list ? `[id="${list}"] [data-component="menu-v2-item"]` : '[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${action}$`, "i") })
    .click()
}

const addRule = async (page: Page, permission: string, pattern: string, action: string) => {
  const add = page.getByTestId("permission-add")
  // A permission field suggests known permissions (a list), so it is a combobox.
  await add.getByRole("combobox", { name: "New rule's permission" }).fill(permission)
  await add.getByRole("textbox", { name: "New rule's pattern" }).fill(pattern)
  await pick(
    page,
    add.locator('[data-component="select-v2-root"][aria-label="New rule\'s action"] [data-component="select-v2"]'),
    action,
  )
  await add.getByRole("button", { name: "Add rule" }).click()
}

// Picks an action in a select named `label`.
const choose = (page: Page, label: string, action: string) =>
  pick(
    page,
    page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`),
    action,
  )

test("the Permissions tab shows each line's level and origin, and edits the agent's own lines", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=permissions`)
  const table = page.getByRole("table", { name: "Permissions" })
  await expect(table.getByRole("row", { name: /question/ })).toContainText("Built-in default")
  await expect(table.getByRole("row", { name: /webfetch/ })).toContainText("Project · Config permission")
  await expect(table.getByRole("row", { name: /external_directory/ })).toContainText("Built-in truncation folder")

  await page.getByRole("button", { name: "Edit permissions" }).click()
  const editor = page.getByTestId("level-editor")
  await expect(editor).toContainText("A call is checked from the specific to the broad, tool first")
  await expect(editor).toContainText("No lines added here.")
  await expect(page.getByTestId("agent-permissions-target")).toContainText(
    ".opencode/opencode.jsonc → agent.build.permission",
  )
  await expect(page.getByTestId("agent-permissions-edit")).toContainText("tracked by the project's git repository")
  // The overlay stays on this agent and section while editing.
  await expect(page.getByRole("tab", { name: "Overview" })).toBeDisabled()

  // The same permission and pattern as an inherited line changes that line.
  await addRule(page, "webfetch", "*", "Deny")
  const webfetch = editor.getByTestId("level-inherited").getByRole("row", { name: /webfetch/ })
  await expect(webfetch).toContainText("changed here (was ask)")
  const impact = page.getByTestId("permission-impact")
  await expect(impact.getByTestId("impact-tools")).toContainText("webfetch")

  // A new line, with a hint for an absolute read pattern.
  await addRule(page, "read", "~/*", "Allow")
  await expect(editor.getByTestId("level-own").getByRole("row", { name: /~\/\*/ })).toContainText("Not saved")
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
  // Back to the lines in force, now with the agent's own.
  await expect(page.getByRole("button", { name: "Edit permissions" })).toBeVisible()
  await expect(table.getByRole("row", { name: /~\/\*/ })).toContainText("Agent")
  await expect(table.getByRole("row", { name: /webfetch/ })).toContainText("Deny")
})

test("an inherited line is changed, deleted or locked at the agent level", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=permissions`)
  await page.getByRole("button", { name: "Edit permissions" }).click()
  const inherited = page.getByTestId("level-inherited")

  // OpenCode's lines can't be deleted in the OpenCode namespace; the project's can.
  await expect(inherited.getByRole("button", { name: "Delete question * at this level" })).toHaveCount(0)
  await inherited.getByRole("button", { name: "Delete webfetch * at this level" }).click()
  await expect(inherited.getByRole("row", { name: /webfetch/ })).toContainText("deleted here")
  await inherited
    .getByRole("row", { name: /webfetch/ })
    .getByRole("button", { name: "Restore" })
    .click()
  await expect(inherited.getByRole("row", { name: /webfetch/ })).not.toContainText("deleted here")

  await choose(page, "Action of webfetch *", "Deny")
  await expect(inherited.getByRole("row", { name: /webfetch/ })).toContainText("changed here (was ask)")
  // Back to its own action: no change.
  await choose(page, "Action of webfetch *", "Ask")
  await expect(inherited.getByRole("row", { name: /webfetch/ })).not.toContainText("changed here")
  await choose(page, "Action of webfetch *", "Deny")

  // Locked: the levels below (sessions) can't change it.
  await inherited
    .getByRole("row", { name: /\*\.env/ })
    .locator('[data-slot="checkbox-v2-control"]')
    .click()
  await page.getByRole("button", { name: "Save permissions" }).click()
  await expect.poll(() => state.lockWrites.length).toBe(1)
  expect(state.permissionWrites[0]!.body.rules).toEqual([{ permission: "webfetch", pattern: "*", action: "deny" }])
  expect(state.lockWrites[0]!.body).toMatchObject({ locks: [{ permission: "read", pattern: "*.env" }], deleted: [] })
})

test("a line a namespace locked can't be changed, deleted or locked by the agent", async ({ page }) => {
  const state = await mockOperator(page)
  state.levels.namespace = {
    lines: [{ permission: "bash", pattern: "rm *", action: "deny" }],
    deleted: [],
    locks: [{ permission: "bash", pattern: "rm *" }],
  }
  await page.goto(`/operator/agents/build${dir}&tab=permissions`)
  const table = page.getByRole("table", { name: "Permissions" })
  await expect(table.getByRole("row", { name: /rm \*/ })).toContainText("Locked by Namespace")
  await page.getByRole("button", { name: "Edit permissions" }).click()
  const row = page.getByTestId("level-inherited").getByRole("row", { name: /rm \*/ })
  await expect(row.getByTestId("locked-above")).toContainText("Locked by Namespace")
  await expect(row.getByRole("button", { name: /Delete/ })).toHaveCount(0)
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Action of bash rm *"]')).toHaveCount(0)
})

test("Change access on a tool opens the Permissions editor filtered to its permission", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=tools`)
  await page.getByRole("table", { name: "Tools sent" }).getByRole("row", { name: /^read/ }).click()
  await page.getByTestId("tool-overlay").getByRole("button", { name: "Change access" }).click()
  await expect(page).toHaveURL(/atab=permissions/)
  await expect(page).toHaveURL(/aedit=1/)
  const editor = page.getByTestId("level-editor")
  await expect(editor).toContainText("Showing the rules for read")
  await expect(editor.getByRole("row", { name: /question/ })).toBeHidden()
  await expect(editor.getByRole("row", { name: /\*\.env/ })).toBeVisible()
})

test("the Edit form shows what the agent inherits, not only its own lines", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build/edit${dir}`)
  const editor = page.getByTestId("level-editor")
  await expect(editor.getByRole("row", { name: /question/ })).toContainText("Built-in default")
  await expect(editor.getByRole("row", { name: /webfetch/ })).toContainText("Config permission")
  await expect(editor).toContainText("No lines added here.")
})

test("a session's own lines: added on the Sessions page, saved with the session, and reset to its agent", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/sessions${dir}&session=ses_op_1&stab=permissions`)
  const panel = page.getByTestId("session-permissions")
  await expect(panel.getByRole("row", { name: /question/ })).toContainText("Built-in default")

  await addRule(page, "webfetch", "*", "Deny")
  await expect(panel.getByTestId("impact-tools")).toContainText("webfetch")
  await panel.getByRole("button", { name: "Save session rules" }).click()
  await expect.poll(() => state.sessionPermissionWrites.length).toBe(1)
  expect(state.sessionPermissionWrites[0]).toEqual({
    sessionID: "ses_op_1",
    body: { rules: [{ permission: "webfetch", pattern: "*", action: "deny" }], deleted: [] },
  })
  await expect(panel.getByTestId("level-inherited").getByRole("row", { name: /webfetch/ })).toContainText(
    "changed here (was ask)",
  )

  await panel.getByRole("button", { name: "Reset to agent" }).click()
  await page.getByRole("dialog").last().getByRole("button", { name: "Reset to agent" }).click()
  await expect.poll(() => state.sessionPermissionWrites.length).toBe(2)
  expect(state.sessionPermissionWrites[1].body).toEqual({ rules: [], deleted: [] })
  await expect(panel).toContainText("No lines added here.")
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

test("Allow for session in the inbox adds the rule to that session's own rules", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/inbox?ask=per_op_1")
  await page.getByTestId("reply-card").getByRole("button", { name: "Allow for session" }).click()
  await expect(page.getByRole("dialog")).toBeHidden()
  await page.goto(`/operator/sessions${dir}&session=ses_op_1&stab=permissions`)
  const panel = page.getByTestId("session-permissions")
  await expect(panel.getByTestId("level-own").getByRole("row", { name: /git push \*/ })).toContainText(
    "Session · Allow for session",
  )
})
