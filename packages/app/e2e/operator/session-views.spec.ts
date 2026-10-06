import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

const sessionID = "ses_smoke_target"

// The fixture's messages; for Detailed, the last answer also has reasoning and a todo update.
function withStep(sessionID: string, limit: number, before?: string) {
  const page = pageMessages(sessionID, limit, before) as { items: Array<{ info: { role: string }; parts: unknown[] }> }
  if (sessionID !== "ses_smoke_target" || before) return page
  const items = structuredClone(page.items)
  const last = items.findLast((message) => message.info.role === "assistant")
  last?.parts.push(
    {
      id: "prt_zz_1_reasoning",
      type: "reasoning",
      text: "The login form posts to the wrong route.",
      time: { start: 1, end: 2 },
    },
    {
      id: "prt_zz_2_todo",
      type: "tool",
      tool: "todowrite",
      callID: "call_todo",
      state: {
        status: "completed",
        input: { todos: [{ content: "Fix the route", status: "in_progress", priority: "high", id: "1" }] },
        output: "",
        title: "1 todo",
        metadata: { todos: [{ content: "Fix the route", status: "in_progress", priority: "high", id: "1" }] },
        time: { start: 1, end: 2 },
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
    pageMessages: withStep,
  })
  await mockOperator(page)
})

test("the Transcript shows every call by exchange, folds what was sent before, and marks what OpenCode added", async ({
  page,
}) => {
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  const views = page.getByTestId("session-view-switch")
  await views.getByRole("button", { name: "Transcript" }).click()
  await expect(page).toHaveURL(/view=transcript/)

  const transcript = page.getByTestId("transcript")
  await expect(transcript.getByTestId("transcript-totals")).toContainText("3 calls")
  await expect(transcript.getByTestId("transcript-exchange")).toContainText("fix the login bug")
  const calls = transcript.getByTestId("transcript-call")
  await expect(calls).toHaveCount(3)
  await expect(calls.nth(0).getByTestId("call-header")).toContainText("Title")
  await expect(calls.nth(1).getByTestId("call-header")).toContainText("Agent step 1")
  await expect(calls.nth(1).getByTestId("call-header")).toContainText("in 7,104 (cache 6,912)")
  await expect(calls.nth(1).getByTestId("call-received")).toContainText("The login form posts to the wrong route.")

  // The third call: the same system text and tools as call 2, the first message folded, a reminder marked.
  const third = calls.nth(2)
  await expect(third.getByTestId("call-system")).toContainText("same as call 2")
  await expect(third.getByTestId("call-tools")).toContainText("11 tools, same as call 2")
  await expect(third.getByTestId("call-messages")).toContainText("Message 1: same as call 2")
  await expect(third.getByTestId("call-messages")).toContainText("Added by OpenCode for this request (not saved)")
  await expect(third.getByTestId("call-messages")).toContainText("Plan mode is off.")

  // The exact request body.
  await third.getByRole("button", { name: "Request JSON" }).click()
  await expect(third.getByTestId("call-raw-request")).toContainText('"model": "claude-opus-4-6"')
  await expect(third.getByTestId("call-raw-request")).toContainText("bytes")

  // The view is kept in the URL.
  await page.reload()
  await expect(page.getByTestId("transcript").getByTestId("transcript-call")).toHaveCount(3)

  // Back to the chat.
  await page.getByTestId("session-view-switch").getByRole("button", { name: "User" }).click()
  await expect(page).not.toHaveURL(/view=/)
  await expect(page.getByTestId("transcript")).toHaveCount(0)
})

test("the filter shows one kind of call", async ({ page }) => {
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}?view=transcript`)
  const transcript = page.getByTestId("transcript")
  await expect(transcript.getByTestId("transcript-call")).toHaveCount(3)
  await transcript.getByRole("button", { name: "Title", exact: true }).click()
  await expect(transcript.getByTestId("transcript-call")).toHaveCount(1)
})

test("Detailed shows the chat with reasoning, todo updates and a marker for each model step", async ({ page }) => {
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  await expect(page.locator('[data-timeline-row="AssistantPart"]').first()).toBeVisible()
  await expect(page.getByText("The login form posts to the wrong route.")).toHaveCount(0)
  await expect(page.getByTestId("step-marker")).toHaveCount(0)

  await page.getByTestId("session-view-switch").getByRole("button", { name: "Detailed" }).click()
  await expect(page).toHaveURL(/view=detailed/)
  await expect(page.getByText("The login form posts to the wrong route.")).toBeVisible()
  // The step's marker, after the last part of the answer, with the message's tokens and cost.
  const marker = page.getByTestId("step-marker").last()
  await expect(marker).toContainText("in 100")
  await expect(marker).toContainText("out 200")
  await expect(marker).toContainText("$0.0100")
  // The todo update the chat hides.
  await expect(page.getByText("Fix the route")).toBeVisible()
})

test("the session overlay opens the full page in any of the three views", async ({ page }) => {
  await page.goto(`/operator/sessions?session=ses_op_1`)
  const buttons = page.getByTestId("open-full-page")
  await expect(buttons).toContainText("Open full page:")
  await buttons.getByRole("button", { name: "Transcript" }).click()
  await expect(page).toHaveURL(/\/session\/ses_op_1\?view=transcript/)
})
