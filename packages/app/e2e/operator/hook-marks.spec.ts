import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// SPEC-0022 §10.6: what hooks did, where it happened, in the User and Detailed views: under a tool call, a deny, an
// input a hook changed (the original on expand) and context; under a user message, its text a hook changed and
// context a hook added; in Detailed, the context step.before added to a step's request. A message a hook refused
// comes back to the composer. The agent's Sys Prompt tab lists the hooks that can add text.

const sessionID = "ses_smoke_target"
const by = (hook: string) => ({ hook, level: "project", file: "/repo/opencode.json", run: `hr.${sessionID}.${hook}` })

function withHooks(id: string, limit: number, before?: string) {
  const page = pageMessages(id, limit, before) as { items: Array<{ info: { role: string }; parts: unknown[] }> }
  if (id !== sessionID || before) return page
  const items = structuredClone(page.items)
  const user = items.findLast((message) => message.info.role === "user")
  const text = user?.parts.find((part) => (part as { type: string }).type === "text") as
    | { text: string; metadata?: unknown }
    | undefined
  if (text) text.metadata = { hook: { prompt: { by: [by("tidy")], original: "fix teh login bug pls" } } }
  user?.parts.push({
    id: "prt_zz_0_hook_context",
    type: "text",
    synthetic: true,
    text: "From hook date:\nToday is 2026-10-21.",
    metadata: { hook: { context: [{ ...by("date"), event: "turn.before", text: "Today is 2026-10-21." }] } },
  })
  items
    .findLast((message) => message.info.role === "assistant")
    ?.parts.push(
      {
        id: "prt_zz_1_denied",
        type: "tool",
        tool: "bash",
        callID: "call_denied",
        state: {
          status: "error",
          input: { command: "rm -rf build", description: "Clean" },
          error: "Denied by hook guard-rm: rm -rf is not allowed",
          time: { start: 1, end: 2 },
        },
      },
      {
        id: "prt_zz_2_changed",
        type: "tool",
        tool: "bash",
        callID: "call_changed",
        state: {
          status: "completed",
          input: { command: "bun test --bail", description: "Test" },
          output: "3 pass\n\nFrom hook ci-status:\nCI: auth/ failing since 10:02",
          title: "Test",
          metadata: {
            output: "3 pass",
            description: "Test",
            hook: {
              input: { by: [by("bail")], original: { command: "bun test", description: "Test" } },
              context: [{ ...by("ci-status"), event: "tool.after", text: "CI: auth/ failing since 10:02" }],
            },
          },
          time: { start: 2, end: 3 },
        },
      },
    )
  return { ...page, items }
}

const pending: unknown[] = []

// The timeline mounts only the rows in view: tall enough for the last exchange, its notes and marks.
test.use({ viewport: { width: 1400, height: 1800 } })

test.beforeEach(async ({ page }) => {
  pending.length = 0
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: withHooks,
    events: () => pending.splice(0),
    eventRetry: 200,
  })
})

for (const view of ["User", "Detailed"])
  test(`the ${view} view marks what hooks did, under each call and message`, async ({ page }) => {
    await mockOperator(page)
    await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
    if (view === "Detailed")
      await page.getByTestId("session-view-switch").getByRole("button", { name: "Detailed" }).click()
    const marks = page.getByTestId("hook-marks")
    await expect(marks).toHaveCount(2)

    // The user message: its text a hook changed (the original on expand), and a hook's context.
    const message = page.getByTestId("message-hook-marks").getByTestId("hook-mark")
    await expect(message).toHaveCount(2)
    await expect(message.nth(0)).toContainText("Text changed by hook tidy")
    // (Opening one moves the timeline; once is enough.)
    if (view === "User") await message.nth(0).locator("summary").click()
    await expect(message.nth(0).locator("pre")).toHaveText("fix teh login bug pls")
    await expect(message.nth(1)).toContainText("From hook date")
    await expect(message.nth(1)).toContainText("Today is 2026-10-21.")

    // The deny, with its reason.
    const denied = marks.filter({ hasText: "Denied by hook guard-rm" })
    await expect(denied).toHaveCount(1)
    await expect(denied).toContainText("rm -rf is not allowed")

    // The changed input, with the original on expand; the context, with its text.
    const changed = marks.filter({ hasText: "Input changed by hook bail" }).getByTestId("hook-mark")
    await expect(changed).toHaveCount(2)
    await expect(changed.nth(0)).toContainText("Input changed by hook bail")
    await expect(changed.nth(0)).toHaveAttribute("title", /bail: Project hook in \/repo\/opencode.json, run hr\./)
    await expect(changed.nth(0).locator("pre")).toContainText('"command": "bun test"')
    await expect(changed.nth(1)).toContainText("From hook ci-status")
    await expect(changed.nth(1)).toContainText("CI: auth/ failing since 10:02")
  })

test("Detailed shows, with its step, the context step.before added to that step's request", async ({ page }) => {
  const state = await mockOperator(page)
  const assistant = (pageMessages(sessionID, 50) as { items: Array<{ info: { id: string; role: string } }> }).items
    .filter((message) => message.info.role === "assistant")
    .at(-1)!.info.id
  state.hooks.runs.push({
    id: `hr.${sessionID}.ci`,
    time: 1,
    event: "step.before",
    hook: "ci",
    level: "namespace",
    file: "/work/acme/.opencode/opencode.jsonc",
    sessionID,
    messageID: assistant,
    outcome: "context",
    context: "CI: auth/ failing since 10:02",
  })
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}?view=detailed`)
  const mark = page.getByTestId("step-hook-marks").getByTestId("hook-mark")
  await expect(mark).toHaveCount(1)
  await expect(mark).toContainText("From hook ci")
  await expect(mark).toContainText("CI: auth/ failing since 10:02")
  await expect(mark).toHaveAttribute("title", /ci: Namespace hook in \/work\/acme/)
})

test("a message a hook refused comes back to the composer, with the hook's reason", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  await expect(page.getByTestId("hook-marks").first()).toBeVisible()
  await expect(page.getByTestId("step-hook-marks")).toHaveCount(0)
  pending.push({
    directory: fixture.directory,
    payload: {
      id: "evt_refused",
      type: "operator.hook.refused",
      properties: {
        sessionID,
        messageID: "msg_refused",
        hook: "policy",
        reason: "no secrets in prompts",
        run: `hr.${sessionID}.policy`,
        message: "Refused by hook policy: no secrets in prompts",
        text: "My password is hunter2",
      },
    },
  })
  await expect(page.getByText("Refused by hook policy: no secrets in prompts").first()).toBeVisible()
  await expect(page.locator('[data-component="prompt-input"]').first()).toContainText("My password is hunter2")
})

test("the agent's Sys Prompt tab lists the hooks in force that can add text, with their level and file", async ({
  page,
}) => {
  await mockOperator(page)
  await page.goto("/operator/agents")
  await page
    .locator('[data-component="operator-table"]')
    .getByRole("row", { name: /reviewer/ })
    .click()
  const overlay = page.getByRole("dialog")
  await overlay.getByRole("tab", { name: "Sys Prompt" }).click()
  const block = overlay.getByTestId("agent-prompt-hooks")
  const hooks = block.getByTestId("agent-prompt-hook")
  // lint (tool.after) and date (turn.before) can add text; audit (turn.after) can't; old is off.
  await expect(hooks).toHaveCount(2)
  await expect(hooks.nth(0)).toContainText("lint")
  await expect(hooks.nth(0)).toContainText("tool.after")
  await expect(hooks.nth(0)).toContainText("Project · /repo/opencode.json")
  await expect(hooks.nth(1)).toContainText("date")
  await expect(hooks.nth(1)).toContainText("Namespace")
})

test("a compaction shows what compaction.before added and a compaction.after hook that stopped the continue", async ({
  page,
}) => {
  const compactID = "msg_zz_compact"
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: (id, limit, before) => {
      const found = withHooks(id, limit, before) as {
        items: Array<{ info: Record<string, unknown>; parts: unknown[] }>
      }
      if (id !== sessionID || before) return found
      const user = found.items.findLast((message) => message.info.role === "user")!
      return {
        ...found,
        items: [
          ...found.items,
          {
            info: { ...user.info, id: compactID, time: { created: Date.now() } },
            parts: [{ id: "prt_zz_compact", type: "compaction", auto: true, messageID: compactID, sessionID }],
          },
        ],
      }
    },
  })
  const state = await mockOperator(page)
  const run = (hook: string, event: string, extra: Record<string, unknown>) => ({
    id: `hr.${sessionID}.${hook}`,
    time: 1,
    event,
    hook,
    level: "project",
    file: "/repo/opencode.json",
    sessionID,
    messageID: compactID,
    ...extra,
  })
  state.hooks.runs.push(
    run("notes", "compaction.before", { outcome: "context", context: "Keep the TODO list." }),
    run("halt", "compaction.after", { outcome: "denied" }),
  )
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  const marks = page.getByTestId("compaction-hook-marks").getByTestId("hook-mark")
  await expect(marks).toHaveCount(2)
  await expect(marks.nth(0)).toContainText("From hook notes")
  await expect(marks.nth(0)).toContainText("Keep the TODO list.")
  await expect(marks.nth(1)).toContainText("No automatic continue: hook halt")
})
