import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { rawFor } from "./mock-calls"
import { evidenceCall, evidenceList } from "./mock-evidence"
import { mockOperator } from "./mock-operator"

// Call details as a list and a pane (transcript_view_spec_v2.md §2), on a session shaped like the
// evidence session: the list groups a step's attempts, the pane shows only what is picked, and a call
// shows earlier turns as sent again.

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
  await page.route(
    (url) => /\/operator\/session\/[^/]+\/(calls|call\/[^/]+(\/raw)?)$/.test(url.pathname),
    (route) => {
      const url = new URL(route.request().url())
      const match = url.pathname.match(/\/operator\/session\/[^/]+\/(calls|call\/([^/]+)(\/raw)?)$/)!
      const body =
        match[1] === "calls"
          ? evidenceList(sessionID)
          : match[3]
            ? rawFor(sessionID, match[2]!, url.searchParams.get("part") ?? "request")
            : evidenceCall(sessionID, match[2]!)
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) })
    },
  )
})

test("the list groups attempts by step; the pane shows the latest turn, a call, a turn or all turns", async ({
  page,
}) => {
  await page.goto(transcriptURL)
  const transcript = page.getByTestId("transcript")
  const list = transcript.getByTestId("transcript-list")
  const pane = transcript.getByTestId("transcript-pane")

  // The list: every turn, with its steps and their attempts.
  await expect(list.getByTestId("transcript-list-all")).toHaveText("All turns")
  await expect(list.getByTestId("transcript-list-turn")).toHaveText([
    "Turn 1 · “Hi” · 1 call · failed",
    "Turn 2 · “hi” · 4 calls · failed",
    "Turn 3 · “hi ” · 1 call",
    "Turn 4 · “can you tell me a bit about yourself” · 5 calls",
  ])
  await expect(list.getByTestId("transcript-list-step")).toHaveText([
    "Step 1 · 4 attempts, all failed (429)",
    "Step 1 · 5 attempts, 1 succeeded",
  ])
  const lines = list.getByTestId("transcript-list-call")
  await expect(lines).toHaveCount(11)
  await expect(lines.nth(0)).toHaveText("Call 1 · step 1 · 403")
  await expect(lines.nth(1)).toHaveText("Call 2 · attempt 1 · 429")
  await expect(lines.nth(5)).toHaveText("Call 6 · step 1 · ok")
  await expect(lines.nth(10)).toHaveText("Call 11 · attempt 5 · ok")
  await expect(lines.nth(1)).toHaveAttribute("data-status", "failed")

  // By default, the latest turn: its failed attempts folded, the one that answered open.
  await expect(pane.getByTestId("transcript-exchange")).toHaveCount(1)
  await expect(pane.getByTestId("transcript-exchange")).toContainText("Turn 4")
  const cards = pane.getByTestId("transcript-call")
  await expect(cards).toHaveCount(5)
  for (const at of [0, 1, 2, 3]) await expect(cards.nth(at)).not.toHaveAttribute("data-open", "")
  await expect(cards.nth(4)).toHaveAttribute("data-open", "")
  await expect(cards.nth(4).getByTestId("call-header")).toContainText("Attempt 5 of 5")

  // A call: its turn's header, that call open, the turn's other calls one line each.
  await lines.nth(10).click()
  await expect(page).toHaveURL(/call=call_11/)
  await expect(pane.getByTestId("transcript-exchange")).toHaveCount(1)
  await expect(cards).toHaveCount(5)
  await expect(pane.locator('[data-call-id="call_11"]')).toHaveAttribute("data-open", "")
  await expect(pane.locator('[data-call-id="call_11"]')).toHaveAttribute("data-focused", "")
  await expect(pane.locator('[data-component="operator-call"][data-open]')).toHaveCount(1)
  // A one-line header opens.
  await pane.locator('[data-call-id="call_8"]').getByTestId("call-toggle").click()
  await expect(pane.locator('[data-call-id="call_8"]')).toHaveAttribute("data-open", "")

  // A turn: only that turn; its last attempt open.
  await list.getByTestId("transcript-list-turn").nth(1).click()
  await expect(page).toHaveURL(/turn=2/)
  await expect(pane.getByTestId("transcript-exchange")).toHaveCount(1)
  await expect(pane.getByTestId("transcript-exchange")).toContainText("Turn 2")
  await expect(cards).toHaveCount(4)
  await expect(pane.locator('[data-component="operator-call"][data-open]')).toHaveCount(1)
  await expect(pane.locator('[data-call-id="call_5"]')).toHaveAttribute("data-open", "")

  // All turns: every turn in order.
  await list.getByTestId("transcript-list-all").click()
  await expect(page).toHaveURL(/turn=all/)
  await expect(pane.getByTestId("transcript-exchange")).toHaveCount(4)
  await expect(cards).toHaveCount(11)
})

test("a call shows earlier turns as sent again, folded by turn, and never as a compaction", async ({ page }) => {
  await page.goto(`${transcriptURL}&call=call_11`)
  const card = page.getByTestId("transcript-pane").locator('[data-call-id="call_11"]')
  const sent = card.getByTestId("call-sent-items")
  await expect(sent.getByTestId("call-earlier-note")).toHaveText(
    "Earlier turns 1–3, sent again: the model receives the whole conversation on every call.",
  )
  const groups = sent.getByTestId("call-earlier")
  await expect(groups).toHaveCount(3)
  await expect(groups.nth(0)).toContainText(
    "Turn 1 · You: “Hi” · no answer (call 1 failed: 403), still sent · 1 token · same as call 1 · read from cache",
  )
  await expect(groups.nth(1)).toContainText("Turn 2 · You: “hi” · no answer (call 5 failed: 429), still sent")
  await expect(groups.nth(2)).toContainText(
    "Turn 3 · You: “hi ” + Answer · sent again · 41 tokens · same as call 6 · partly from cache",
  )
  // Folded until opened; the call's own turn is open.
  await expect(groups.nth(2).getByTestId("call-item")).toHaveCount(0)
  await groups.nth(2).locator(":scope > button").click()
  await expect(groups.nth(2).getByTestId("call-item")).toHaveCount(2)
  // The call's own turn: its message, first sent by the first attempt.
  await expect(sent.getByTestId("call-seen")).toContainText("Same as call 7: 1 items")
  // The Sent table folds them the same way, and no card carries another turn's header.
  const table = card.getByTestId("call-accounting")
  await expect(table.getByTestId("accounting-earlier-note")).toHaveCount(1)
  await expect(table.getByTestId("accounting-earlier")).toHaveCount(3)
  await expect(card.getByTestId("transcript-exchange")).toHaveCount(0)
  await expect(card).not.toContainText("compaction")

  // An attempt of turn 2 sends turn 1 again, which got no answer.
  await page.goto(`${transcriptURL}&call=call_5`)
  const attempt = page.getByTestId("transcript-pane").locator('[data-call-id="call_5"]')
  await expect(attempt.getByTestId("call-earlier")).toHaveText([
    "Turn 1 · You: “Hi” · no answer (call 1 failed: 403), still sent · 1 token · same as call 1 · read from cache",
  ])
  await expect(attempt.getByTestId("call-earlier-note")).toHaveText(
    "Earlier turn 1, sent again: the model receives the whole conversation on every call.",
  )
})

test("filters narrow the list; a selection outside them says so; the selection is kept", async ({ page }) => {
  await page.goto(transcriptURL)
  const transcript = page.getByTestId("transcript")
  const list = transcript.getByTestId("transcript-list")
  await list.getByTestId("transcript-list-call").nth(10).click()

  // Errors and retries: only failed calls are listed; call 11 is not among them.
  await transcript.getByRole("button", { name: "Errors and retries", exact: true }).click()
  await expect(list.getByTestId("transcript-list-call")).toHaveCount(9)
  await expect(transcript.getByTestId("transcript-not-in-filter")).toContainText("Not in the current filter.")
  await transcript.getByTestId("transcript-not-in-filter").getByRole("button", { name: "Show everything" }).click()
  await expect(list.getByTestId("transcript-list-call")).toHaveCount(11)
  await expect(transcript.locator('[data-call-id="call_11"]')).toHaveAttribute("data-focused", "")

  // Switching to User and back finds the same call picked.
  await page.getByTestId("session-view-switch").getByRole("button", { name: "User" }).click()
  await expect(page.getByTestId("transcript")).toHaveCount(0)
  await page.getByTestId("session-view-switch").getByRole("button", { name: "Transcript" }).click()
  await expect(page.getByTestId("transcript").locator('[data-call-id="call_11"]')).toHaveAttribute("data-focused", "")
  await expect(page.getByTestId("transcript-list-call").nth(10)).toHaveAttribute("data-active", "")
})
