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

test("the agent's prompt tabs are Sys Prompt and Tool Prompt, and old Prompt links still open Sys Prompt", async ({
  page,
}) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=prompt`)
  await expect(page.getByRole("tab", { name: "Sys Prompt" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tab", { name: "Tool Prompt" })).toBeVisible()
  await expect(page.locator('[data-slot="operator-prompt-section"]').first()).toBeVisible()
})

test("Tool Prompt lists the tools sent and not sent, and a tool opens with its text, schema and rules", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=tools`)

  await expect(page.getByTestId("tool-prompt-summary")).toContainText("3 tools sent")
  await expect(page.getByTestId("tool-prompt-summary")).toContainText("3 not sent")
  const sent = page.getByRole("table", { name: "Tools sent" })
  await expect(sent.locator("tbody tr")).toHaveCount(3)
  await expect(sent).toContainText("subagent list (1)")
  await expect(sent).toContainText("allowed · asks for *.env")

  const notSent = page.getByRole("table", { name: "Tools not sent" })
  await expect(notSent.getByRole("row", { name: /webfetch/ })).toContainText("Permission")
  await expect(notSent.getByRole("row", { name: /webfetch/ })).toContainText(
    "rule #4 webfetch * deny, from Config permission",
  )
  await expect(notSent.getByRole("row", { name: /apply_patch/ })).toContainText(
    "Used instead of edit and write only for GPT models",
  )
  await expect(notSent.getByRole("row", { name: /invalid/ })).toContainText("Internal")
  await expect(page.getByTestId("tool-prompt-json")).toContainText('"input_schema"')

  // A tool opens over the agent: its text with where it comes from, and the rule that decides.
  await sent.getByRole("row", { name: /read/ }).click()
  const overlay = page.getByTestId("tool-overlay")
  await expect(overlay.getByTestId("tool-trace")).toContainText("OpenCode's text")
  await expect(overlay.getByTestId("tool-trace")).toContainText("File: packages/opencode/src/tool/read.txt")
  await expect(overlay.getByTestId("tool-overlay-rules")).toContainText("OpenCode default")
  await expect(overlay.getByTestId("decisive-rule")).toHaveCount(1)
  await expect(overlay.getByRole("row", { name: /\*\.env/ })).toContainText("Decides")
  await page.keyboard.press("Escape")
  await expect(overlay).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "Tool Prompt" })).toHaveAttribute("aria-selected", "true")

  // A tool allowed only for some inputs shows the note the fork adds.
  await sent.getByRole("row", { name: /^read/ }).click()
  await expect(page.getByTestId("tool-overlay-note")).toContainText("Added by the fork: allowed inputs")
  await expect(page.getByTestId("tool-overlay-note")).toContainText("Allowed only for: `src/*`.")
  await page.keyboard.press("Escape")

  // bash's text is filled in from a template, with the values used.
  await sent.getByRole("row", { name: /bash/ }).click()
  await expect(page.getByTestId("tool-trace")).toContainText(
    "Filled in from the template packages/opencode/src/tool/shell/shell.txt with os linux, shell bash",
  )
  await page.keyboard.press("Escape")

  // Run as a subagent: task is no longer sent, because of the rule the subagent session gets.
  await page.getByTestId("tool-prompt-runs-as").getByRole("button", { name: "Subagent" }).click()
  await expect(page.getByTestId("tool-prompt-summary")).toContainText("2 tools sent")
  await expect(notSent.getByRole("row", { name: /task/ })).toContainText("Subagent session")
  await expect(notSent.getByRole("row", { name: /task/ })).toContainText(
    "added when build is started by task, because build's own rules do not mention task",
  )
  expect(state.toolPromptQueries.some((query) => query.get("runsAs") === "subagent")).toBe(true)

  // Started from a session: its rules pass to the subagent, so the prompt is asked for with it.
  const startedFrom = page.locator(
    '[data-component="select-v2-root"][aria-label="Started from"] [data-component="select-v2"]',
  )
  await expect(startedFrom).toContainText("A new session (no rules of its own)")
  await startedFrom.click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^Fix the parser/ })
    .click()
  await expect.poll(() => state.toolPromptQueries.some((query) => query.get("parent") === "ses_op_1")).toBe(true)
})

test("Last sent shows the tools of the agent's last request, exactly as sent", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=tools`)
  await page.getByTestId("tool-prompt-view").getByRole("button", { name: "Last sent" }).click()
  await expect(page.getByTestId("tool-prompt-summary")).toContainText("3 tools sent")
  await expect(page.getByTestId("tool-prompt-summary")).toContainText("openai-chat")
  await expect(page.getByTestId("tool-prompt-summary")).toContainText("12,345 input tokens")
  await expect(page.getByTestId("tool-prompt-compare")).toContainText("The same tools as Would be sent.")
  await expect(page.getByTestId("tool-prompt-json")).toContainText('"type": "function"')
})

test("an agent with no request yet has Last sent off, and says so", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/triage${dir}&tab=tools`)
  await expect(page.getByTestId("tool-prompt-not-captured")).toBeVisible()
  await expect(page.getByTestId("tool-prompt-view").getByRole("button", { name: "Last sent" })).toBeDisabled()
})
