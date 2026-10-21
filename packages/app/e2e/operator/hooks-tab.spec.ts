import { expect, type Page, test } from "@playwright/test"
import { directory, mockOperator } from "./mock-operator"

// SPEC-0022 §10.1–§10.5 on mocks: the Capabilities page's Hooks tab lists the hooks in force by event with where
// each comes from and its state, filtered to blocking or watch events; Runs lists runs and opens one; a new hook is
// made from a template script and tested; an inherited hook is turned off here; a locked one offers neither; Settings
// → Hooks pauses them all.

const pick = async (page: Page, label: string, option: string) => {
  await page
    .getByRole("dialog")
    .locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`)
    .click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) })
    .click()
}

test("the Hooks tab lists the hooks in force by event, with where each comes from and its state", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/capabilities?tab=hooks")
  const tab = page.getByTestId("hooks-tab")
  const rows = tab.locator("tbody tr")
  await expect(rows).toHaveCount(5)
  // In §5's order: turn.before, step.before, tool.before, tool.after, turn.after.
  await expect(rows.nth(0)).toContainText("turn.before")
  await expect(rows.nth(0)).toContainText("date")
  await expect(rows.nth(0)).toContainText("Namespace")
  await expect(rows.nth(1)).toContainText("old")
  await expect(rows.nth(1)).toContainText("Off here")
  await expect(rows.nth(2)).toContainText("policy")
  await expect(rows.nth(2)).toContainText("Locked")
  await expect(rows.nth(3)).toContainText("lint")
  await expect(rows.nth(3)).toContainText("This level")
  await expect(rows.nth(3)).toContainText("Context")
  await expect(rows.nth(4)).toContainText("audit")
  await expect(rows.nth(4)).toContainText("Global")

  // Watch events only.
  await tab.locator('[data-component="select-v2-root"][aria-label="Which hooks"] [data-component="select-v2"]').click()
  await page.getByRole("option", { name: "Watch", exact: true }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0)).toContainText("audit")

  // Runs: a row opens the run, with everything it recorded.
  await tab.getByTestId("hooks-view").getByRole("button", { name: "Runs" }).click()
  const runs = page.getByTestId("hook-runs").locator("tbody tr")
  await expect(runs).toHaveCount(1)
  await runs.first().click()
  const run = page.getByTestId("hook-run")
  await expect(run).toContainText("Context")
  await expect(run).toContainText("0 problems")
  await expect(run).toContainText("41 ms")
})

test("a new hook from a template script, then Test: what its answer would do", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/capabilities?tab=hooks")
  await page.getByRole("button", { name: "New hook" }).click()
  const form = page.getByTestId("hook-form")
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("guard-rm")
  // A new hook starts on tool.before (the event picker lists all sixteen, by group).
  await expect(form.getByRole("button", { name: "Event", exact: true })).toContainText(
    "Tool and subagent · tool.before",
  )
  await pick(page, "Script", "New script…")
  await form.getByRole("textbox", { name: "Script name" }).fill("guard-rm")
  await form.getByRole("button", { name: "Write the script" }).click()
  await expect
    .poll(() => state.hooks.writes.at(-1)?.body)
    .toMatchObject({ name: "guard-rm", language: "shell", event: "tool.before" })
  await form.getByRole("textbox", { name: "Matches" }).fill("bash")
  await form.getByRole("button", { name: "Save" }).click()
  await expect
    .poll(() => state.hooks.writes.findLast((write) => write.route === "PUT /operator/hook")?.body)
    .toMatchObject({ name: "guard-rm", hook: { event: "tool.before", command: "hooks/guard-rm.sh", match: ["bash"] } })
  const overview = page.getByTestId("hook-overview")
  await expect(overview).toContainText("hooks/guard-rm.sh")

  await overview.getByRole("button", { name: "Test" }).click()
  const tester = page.getByTestId("hook-test")
  await expect(tester.locator("textarea")).toHaveValue(/"tool": "bash"/)
  await tester.getByRole("button", { name: "Run" }).click()
  const result = page.getByTestId("hook-test-result")
  await expect(result).toContainText("Denied")
  await expect(result.getByTestId("hook-test-would")).toContainText(
    "Would deny the tool call with: rm -rf is not allowed",
  )
  await expect(result).toContainText('{"allow":false}')
})

test("an inherited hook is turned off here; a locked one offers neither Turn off nor Override", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/capabilities?tab=hooks")
  const rows = page.getByTestId("hooks-tab").locator("tbody tr")
  await rows.filter({ hasText: "date" }).click()
  const overview = page.getByTestId("hook-overview")
  await overview.getByRole("button", { name: "Turn off here" }).click()
  await expect
    .poll(() => state.hooks.writes.at(-1))
    .toMatchObject({
      route: "POST /operator/hook/state",
      body: { name: "date", off: true },
    })
  await expect(overview).toContainText("Off here")
  await expect(overview.getByRole("button", { name: "Turn on here" })).toBeVisible()

  await page.goto("/operator/capabilities?tab=hooks&hook=policy&htab=overview")
  const locked = page.getByTestId("hook-overview")
  await expect(locked).toContainText("Locked at Global")
  await expect(locked.getByRole("button", { name: "Turn off here" })).toHaveCount(0)
  await expect(locked.getByRole("button", { name: "Override here" })).toHaveCount(0)
  await expect(locked.getByRole("button", { name: "Test" })).toBeVisible()
})

test("Settings → Hooks pauses every hook, and the tab says so", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/capabilities?tab=hooks")
  await page.getByTestId("hooks-tab").getByRole("button", { name: "Settings" }).click()
  const settings = page.getByTestId("hook-settings")
  await settings.getByText("Pause all hooks", { exact: true }).click()
  await expect.poll(() => state.hooks.paused).toBe(true)
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("hook-settings")).toBeHidden()
  await expect(page.getByTestId("hooks-paused")).toBeVisible()
})

test("an agent's Hooks tab: inherited ones turned off for it (not a locked one), its own added, its runs", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/agents")
  await page
    .locator('[data-component="operator-table"]')
    .getByRole("row", { name: /reviewer/ })
    .click()
  const overlay = page.getByRole("dialog")
  await overlay.getByRole("tab", { name: "Hooks" }).click()
  const tab = overlay.getByTestId("agent-hooks")
  const inherited = tab.getByTestId("agent-inherited-hook")
  await expect(inherited).toHaveCount(5)
  await expect(inherited.filter({ hasText: "policy" })).toContainText("Locked: it runs for every agent")
  await expect(
    inherited.filter({ hasText: "policy" }).getByRole("button", { name: "Turn off for this agent" }),
  ).toHaveCount(0)
  await inherited.filter({ hasText: "date" }).getByRole("button", { name: "Turn off for this agent" }).click()
  await expect
    .poll(() => state.hooks.writes.at(-1))
    .toMatchObject({
      route: "POST /operator/hook/state",
      body: { agent: "reviewer", name: "date", off: true },
    })

  await tab.getByRole("button", { name: "Add a hook" }).click()
  const form = tab.getByTestId("hook-form")
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("notes")
  await form.getByRole("button", { name: "Save" }).isDisabled()
  await overlay.locator('[data-component="select-v2-root"][aria-label="Script"] [data-component="select-v2"]').click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^hooks\/lint\.sh$/ })
    .click()
  await form.getByRole("button", { name: "Save" }).click()
  await expect
    .poll(() => state.hooks.writes.findLast((write) => write.route === "PUT /operator/hook")?.body)
    .toMatchObject({ agent: "reviewer", name: "notes", hook: { command: "hooks/lint.sh" } })
  await expect(tab.getByTestId("agent-own-hook")).toContainText("notes")
  await expect(tab.getByTestId("agent-hook-runs")).toBeVisible()
})

test("a session's Hooks tab lists what hooks did in it", async ({ page }) => {
  const state = await mockOperator(page)
  state.hooks.runs.push({
    id: "hr.ses_op_1.guard",
    time: Date.now() - 5_000,
    event: "tool.before",
    hook: "guard",
    level: "namespace",
    file: "/work/acme/.opencode/opencode.jsonc",
    sessionID: "ses_op_1",
    tool: "bash",
    outcome: "denied",
    reason: "no rm -rf",
  })
  await page.goto("/operator/sessions?session=ses_op_1&stab=hooks")
  const runs = page.getByTestId("session-hook-runs").locator("tbody tr")
  await expect(runs).toHaveCount(1)
  await expect(runs.first()).toContainText("guard")
  await expect(runs.first()).toContainText("Denied")
})

test("the agent form's Hooks section: an existing agent's hooks; a new agent's once it's saved", async ({ page }) => {
  await mockOperator(page)
  const dir = `?dir=${encodeURIComponent(directory)}`
  await page.goto(`/operator/agents/reviewer/edit${dir}`)
  const section = page.getByTestId("agent-hooks")
  await expect(section.getByTestId("agent-inherited-hook")).toHaveCount(5)
  await expect(section.getByRole("button", { name: "Add a hook" })).toBeVisible()
  await page.goto(`/operator/agents/new${dir}`)
  await expect(page.getByText("Save the agent first: its hooks are added once it exists.")).toBeVisible()
  await expect(page.getByTestId("agent-hooks")).toHaveCount(0)
})
