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
  // OpenCode's own text saved with the last user message (hidden in the chat).
  items
    .findLast((message) => message.info.role === "user")
    ?.parts.push({
      id: "prt_zz_0_synthetic",
      type: "text",
      synthetic: true,
      text: "Called the Read tool with login.ts",
    })
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

test("the Transcript accounts for every token: session totals, turns, and each call's table summing to what was billed", async ({
  page,
}) => {
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  const views = page.getByTestId("session-view-switch")
  await views.getByRole("button", { name: "Transcript" }).click()
  await expect(page).toHaveURL(/view=transcript/)

  const transcript = page.getByTestId("transcript")
  // The session: totals by kind of call, and where the input went.
  const totals = transcript.getByTestId("transcript-totals")
  await expect(totals.getByRole("row", { name: /This session/ })).toContainText("3")
  await expect(totals.getByRole("row", { name: /Side calls/ })).toBeVisible()
  await expect(totals).toContainText("The provider reported no cost for calls 1, 2.")
  await expect(transcript.getByTestId("transcript-section-input")).toContainText("Where the input tokens went")
  await expect(transcript.getByTestId("transcript-input-by")).toContainText("Formatting and unattributed")
  await expect(transcript.getByTestId("transcript-counting")).toContainText("No tokenizer")

  // The turn, with its totals.
  const turn = transcript.getByTestId("transcript-exchange")
  await expect(turn).toContainText("Turn 1")
  await expect(turn).toContainText("fix the login bug")
  await expect(turn).toContainText("3 calls · in 14,824")
  const calls = transcript.getByTestId("transcript-call")
  await expect(calls).toHaveCount(3)
  await expect(calls.nth(0).getByTestId("call-header")).toContainText("Title")
  await expect(calls.nth(1).getByTestId("call-header")).toContainText("Agent step 1")
  await expect(calls.nth(1).getByTestId("call-header")).toContainText("in 7,104 (cache 6,912)")
  await expect(calls.nth(1).getByTestId("call-header")).toContainText("gen-2")
  // A call's details load once it scrolls into view.
  await calls.nth(1).scrollIntoViewIfNeeded()
  await expect(calls.nth(1).getByTestId("call-received")).toContainText("The login form posts to the wrong route.")

  // Every call's table sums exactly to the billed input.
  for (const at of [0, 1, 2]) {
    await calls.nth(at).scrollIntoViewIfNeeded()
    const table = calls.nth(at).getByTestId("call-accounting")
    await expect(table.getByTestId("accounting-total-input")).toBeVisible()
    const cells = await table
      .locator('[data-testid="accounting-row"] td:nth-child(2), [data-testid="accounting-formatting"] td:nth-child(2)')
      .allInnerTexts()
    const sum = cells.reduce((total, text) => total + Number(text.replace(/[^\d-]/g, "")), 0)
    const billed = Number(
      (await table.getByTestId("accounting-total-input").locator("td").first().innerText()).replace(/[^\d]/g, ""),
    )
    expect(sum).toBe(billed)
  }

  // The third call: the tools item, the added reminder, the measured delta and the cache boundary.
  const third = calls.nth(2)
  const table = third.getByTestId("call-accounting")
  await expect(table).toContainText("Tools (2)")
  await expect(table).toContainText("Added by OpenCode for this request (not saved): switch to build")
  await expect(table.getByTestId("accounting-delta")).toContainText("Measured: +96 since call 2")
  await expect(table.getByTestId("accounting-boundary")).toContainText("Cache boundary")
  await expect(third.getByTestId("accounting-cost")).toContainText("gen-3")
  // Items sent before fold with their count; Expand everything shows them all.
  await expect(third.getByTestId("call-seen")).toContainText("Same as call 2: 1 items · 4 tokens")
  await expect(third.getByText("export function login() {}")).toHaveCount(0)
  await transcript.getByRole("button", { name: "Expand everything" }).click()
  await expect(third.getByText("export function login() {}")).toBeVisible()
  await expect(third.getByTestId("call-sent-items")).toContainText("fix the login bug")
  // What changed since the previous call.
  await expect(third.getByTestId("call-changes")).toContainText("What changed since call 2")
  await expect(third.getByTestId("call-changes")).toContainText("+96 tokens, measured")

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

test("the filter shows one kind of call; a turn folds", async ({ page }) => {
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}?view=transcript`)
  const transcript = page.getByTestId("transcript")
  await expect(transcript.getByTestId("transcript-call")).toHaveCount(3)
  await transcript.getByRole("button", { name: "Side calls", exact: true }).click()
  await expect(transcript.getByTestId("transcript-call")).toHaveCount(1)
  await transcript.getByRole("button", { name: "All", exact: true }).click()
  await transcript.getByTestId("transcript-exchange").click()
  await expect(transcript.getByTestId("transcript-call")).toHaveCount(0)
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

test("Detailed shows, under the message, OpenCode's saved and in-memory texts and its side calls", async ({ page }) => {
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}?view=detailed`)
  const extras = page.getByTestId("detailed-extras").last()
  await expect(extras).toContainText("OpenCode's text, saved with the message")
  await expect(extras.getByTestId("detailed-added")).toContainText("The switch back to building")
  await expect(extras.getByTestId("detailed-side")).toContainText("Title")
  await extras.getByTestId("detailed-side").getByRole("button", { name: "Open in Transcript" }).click()
  await expect(page).toHaveURL(/view=transcript&call=call_1|call=call_1&view=transcript|view=transcript.*call=call_1/)
  // Nothing of it in the User view.
  await page.getByTestId("session-view-switch").getByRole("button", { name: "User" }).click()
  await expect(page.getByTestId("detailed-extras")).toHaveCount(0)
})

test("Transcript search looks through what calls sent and received", async ({ page }) => {
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}?view=transcript`)
  const transcript = page.getByTestId("transcript")
  await expect(transcript.getByTestId("transcript-call")).toHaveCount(3)
  await transcript.getByRole("textbox", { name: "Search the transcript" }).fill("Plan mode is off")
  await expect(transcript.getByTestId("transcript-call")).toHaveCount(1)
  await expect(transcript.getByTestId("transcript-call").first().getByTestId("call-header")).toContainText("Call 3")
})
