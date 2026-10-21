import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// SPEC-0022 §10.6: what hooks did to tool calls, under each call, in the User and Detailed views: a call a hook
// denied, an input and an output a hook changed (the original on expand), and context a hook added.

const sessionID = "ses_smoke_target"
const by = (hook: string) => ({ hook, level: "project", file: "/repo/opencode.json", run: `hr.${sessionID}.${hook}` })

function withHooks(id: string, limit: number, before?: string) {
  const page = pageMessages(id, limit, before) as { items: Array<{ info: { role: string }; parts: unknown[] }> }
  if (id !== sessionID || before) return page
  const items = structuredClone(page.items)
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

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: withHooks,
  })
  await mockOperator(page)
})

for (const view of ["User", "Detailed"])
  test(`the ${view} view marks what hooks did, under each call`, async ({ page }) => {
    await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
    if (view === "Detailed")
      await page.getByTestId("session-view-switch").getByRole("button", { name: "Detailed" }).click()
    const marks = page.getByTestId("hook-marks")
    await expect(marks).toHaveCount(2)

    // The deny, with its reason.
    await expect(marks.nth(0)).toContainText("Denied by hook guard-rm")
    await expect(marks.nth(0)).toContainText("rm -rf is not allowed")

    // The changed input, with the original on expand; the context, with its text.
    const changed = marks.nth(1).getByTestId("hook-mark")
    await expect(changed).toHaveCount(2)
    await expect(changed.nth(0)).toContainText("Input changed by hook bail")
    await expect(changed.nth(0)).toHaveAttribute("title", /bail: Project hook in \/repo\/opencode.json, run hr\./)
    await changed.nth(0).locator("summary").click()
    await expect(changed.nth(0).locator("pre")).toContainText('"command": "bun test"')
    await expect(changed.nth(1)).toContainText("From hook ci-status")
    await expect(changed.nth(1)).toContainText("CI: auth/ failing since 10:02")
  })
