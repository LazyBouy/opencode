import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { callsFor } from "./mock-calls"
import { mockOperator } from "./mock-operator"

// The Transcript's three sections (transcript_view_spec_v2.md §1): each opens and closes on its own,
// says what it holds while closed, and everything inside keeps its state.

const sessionID = "ses_smoke_target"
const transcriptURL = `/server/${base64Encode(fixture.serverKey)}/session/${sessionID}?view=transcript`

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await mockOperator(page)
})

test("sections open and close on their own, and what is open inside them is kept", async ({ page }) => {
  await page.goto(transcriptURL)
  const transcript = page.getByTestId("transcript")
  const sections = transcript.locator('[data-slot="operator-transcript-section"]')
  await expect(sections).toHaveCount(3)
  await expect(sections.nth(0)).toHaveAttribute("data-section", "summary")
  await expect(sections.nth(1)).toHaveAttribute("data-section", "input")
  await expect(sections.nth(2)).toHaveAttribute("data-section", "calls")

  // Open a call's Request JSON, pick a filter.
  const third = transcript.getByTestId("transcript-call").nth(2)
  await third.scrollIntoViewIfNeeded()
  await third.getByRole("button", { name: "Request JSON" }).click()
  await expect(third.getByTestId("call-raw-request")).toBeVisible()

  // Closing a section shows what it holds; reopening finds everything as it was.
  const calls = transcript.getByTestId("transcript-section-calls")
  const head = calls.locator('[data-slot="operator-transcript-section-head"]')
  await head.click()
  await expect(head).toContainText("Call details · 1 turns · 3 calls")
  await expect(third).toBeHidden()
  await transcript
    .getByTestId("transcript-section-summary")
    .locator('[data-slot="operator-transcript-section-head"]')
    .click()
  await expect(transcript.getByTestId("transcript-section-summary")).toContainText("Summary · 3 calls · input")
  await head.click()
  await expect(third.getByTestId("call-raw-request")).toBeVisible()

  // Switching to User and back, and a reload, keep it too.
  await page.getByTestId("session-view-switch").getByRole("button", { name: "User" }).click()
  await expect(page.getByTestId("transcript")).toHaveCount(0)
  await page.getByTestId("session-view-switch").getByRole("button", { name: "Transcript" }).click()
  await expect(page.getByTestId("transcript-section-summary")).not.toHaveAttribute("data-open", "")
  await expect(page.getByTestId("transcript-call").nth(2).getByTestId("call-raw-request")).toBeVisible()
  await page.reload()
  await expect(page.getByTestId("transcript-section-summary")).not.toHaveAttribute("data-open", "")
  await expect(page.getByTestId("transcript-call").nth(2).getByTestId("call-raw-request")).toBeVisible()
})

test("a call shows how its Dynamic layers were resolved, as stored with it", async ({ page }) => {
  await page.goto(transcriptURL)
  const transcript = page.getByTestId("transcript")
  const third = transcript.getByTestId("transcript-call").nth(2)
  await third.scrollIntoViewIfNeeded()
  const part = third.getByTestId("call-resolutions")
  await expect(part).toContainText("Dynamic layers: how they were resolved (2)")
  await expect(part).toContainText("1 sent as OpenCode wrote them")
  await expect(part.getByTestId("call-resolution")).toHaveCount(0)
  await part.getByRole("button", { name: /Dynamic layers/ }).click()
  const layers = part.getByTestId("call-resolution")
  await expect(layers).toHaveCount(2)
  await expect(layers.nth(0)).toHaveAttribute("data-layer", "opencode:generated.instructions")
  await layers.nth(0).getByTestId("prompt-resolution").locator("summary").click()
  await expect(layers.nth(0)).toContainText("lost to AGENTS.md (precedence (name))")
  await expect(layers.nth(1).getByTestId("resolution-differs")).toBeVisible()
  // The title call resolved none: no part.
  await expect(transcript.getByTestId("transcript-call").nth(0).getByTestId("call-resolutions")).toHaveCount(0)
})

test("a session from before recording says why each section has no details, and shows its stored totals", async ({
  page,
}) => {
  const base = callsFor(sessionID)
  const step = {
    calls: 1,
    input: 7104,
    cacheRead: 0,
    cacheWrite: 0,
    new: 7104,
    output: 65,
    reasoning: 39,
    cost: 0.02,
    providerCost: 0,
  }
  await page.route(
    (url) => /\/operator\/session\/[^/]+\/calls$/.test(url.pathname),
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...base,
          calls: [],
          turns: [{ ...base.turns[0], calls: [], unrecorded: 1, status: "unrecorded", totals: step }],
          session: {
            ...base.session,
            rows: [
              { id: "agent", totals: step },
              { id: "side", totals: { ...step, calls: 0, input: 0, new: 0, output: 0, reasoning: 0, cost: 0 } },
              { id: "retries", totals: { ...step, calls: 0, input: 0, new: 0, output: 0, reasoning: 0, cost: 0 } },
              { id: "session", totals: step },
            ],
            inputBy: [],
            providerMissing: [],
          },
          unrecorded: [{ assistantMessageID: "msg_old", exchange: 1, totals: step }],
          availability: { recorded: "none", calls: "before-recording", input: "before-recording" },
          totals: { calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0 },
        }),
      }),
  )
  await page.goto(transcriptURL)
  const transcript = page.getByTestId("transcript")
  await expect(transcript.getByTestId("transcript-section-input")).toContainText(
    "No details currently available: this session's calls were not recorded (recording started on 6 October 2026)",
  )
  await expect(transcript.getByTestId("transcript-section-summary")).toContainText(
    "From OpenCode's stored usage; the calls themselves were not recorded.",
  )
  await expect(transcript.getByTestId("transcript-totals")).toContainText("7,104")
  await expect(transcript.getByTestId("transcript-unrecorded")).toContainText(
    "No details currently available: not recorded",
  )
})
