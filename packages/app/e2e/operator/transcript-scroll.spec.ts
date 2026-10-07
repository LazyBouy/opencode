import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { callFor, callsFor, rawFor } from "./mock-calls"
import { mockOperator } from "./mock-operator"

// Expanding anything in the Transcript never moves the page (transcript_view_spec_v2.md §5): a long
// session (6 turns × 5 calls), scrolled to the middle; after each action the control stays where it was
// on screen and the transcript never jumps back to the top.

const sessionID = "ses_smoke_target"
const TURNS = 6
const PER_TURN = 5
// Events the page picks up when it reconnects to the event stream (every 200 ms).
const pending: unknown[] = []

const longList = () => {
  const base = callsFor(sessionID)
  const template = base.calls[2]!
  const calls = Array.from({ length: TURNS * PER_TURN }, (_, at) => ({
    ...template,
    callID: `call_${at + 1}`,
    index: at + 1,
    exchange: Math.floor(at / PER_TURN) + 1,
    step: (at % PER_TURN) + 1,
    userMessageID: `msg_turn_${Math.floor(at / PER_TURN) + 1}`,
  }))
  const turns = Array.from({ length: TURNS }, (_, at) => ({
    ...base.turns[0]!,
    index: at + 1,
    userMessageID: `msg_turn_${at + 1}`,
    text: `turn ${at + 1}`,
    calls: calls.filter((call) => call.exchange === at + 1).map((call) => call.callID),
  }))
  const exchanges = turns.map((turn) => ({
    userMessageID: turn.userMessageID,
    index: turn.index,
    text: turn.text,
    time: 1_760_000_000_000,
    recorded: true,
  }))
  return { ...base, calls, turns, exchanges }
}

const detailOf = (callID: string) => {
  const index = Number(callID.replace("call_", ""))
  return { ...callFor(sessionID, "call_3")!, callID, index }
}

test.beforeEach(async ({ page }) => {
  pending.length = 0
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    events: () => pending.splice(0),
    eventRetry: 200,
  })
  await mockOperator(page)
  // The long session's calls (routes added later win).
  await page.route(
    (url) => /\/operator\/session\/[^/]+\/(calls|call\/[^/]+(\/raw)?)$/.test(url.pathname),
    (route) => {
      const url = new URL(route.request().url())
      const match = url.pathname.match(/\/operator\/session\/[^/]+\/(calls|call\/([^/]+)(\/raw)?)$/)!
      const body =
        match[1] === "calls"
          ? longList()
          : match[3]
            ? rawFor(sessionID, match[2]!, url.searchParams.get("part") ?? "request")
            : detailOf(match[2]!)
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) })
    },
  )
})

const scroller = (page: Page) => page.locator('[data-component="operator-transcript"]')
const scrollTop = (page: Page) => scroller(page).evaluate((element) => element.scrollTop)
const top = async (locator: Locator) => (await locator.boundingBox())!.y

// Scrolls the transcript (not the control) so the control sits in the visible area (`at` 0.5: the
// middle; 0: the top), and lets the cards around it load.
async function centred(page: Page, locator: Locator, at = 0.5) {
  await locator.evaluate((element, at) => {
    const scroller = element.closest('[data-component="operator-transcript"]') as HTMLElement
    const offset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTop += offset - scroller.clientHeight * at
  }, at)
  await page.waitForTimeout(600)
  return locator
}

// Clicks without Playwright scrolling the control into view first, then checks nothing moved.
async function stays(page: Page, name: string, control: Locator, action?: () => Promise<void>) {
  const before = await top(control)
  if (action) await action()
  else await control.dispatchEvent("click")
  await page.waitForTimeout(400)
  expect(Math.abs((await top(control)) - before), `${name}: the control moved`).toBeLessThanOrEqual(2)
  expect(await scrollTop(page), `${name}: the transcript jumped to the top`).toBeGreaterThan(0)
}

test("expanding, loading and refreshing never move the transcript", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}?view=transcript`)
  await expect(page.getByTestId("transcript-call")).toHaveCount(TURNS * PER_TURN)
  const cards = page.getByTestId("transcript-call")

  // A card's controls appear once it scrolls into view and loads its details.
  const inside = async (at: number, control: (card: Locator) => Locator) => {
    await centred(page, cards.nth(at).getByTestId("call-header"))
    await control(cards.nth(at)).waitFor({ state: "attached" })
    return centred(page, control(cards.nth(at)))
  }
  // Request JSON and Response open below their buttons.
  await stays(page, "Request JSON", await inside(14, (card) => card.getByRole("button", { name: "Request JSON" })))
  await stays(page, "Response", await inside(14, (card) => card.getByRole("button", { name: "Response" })))
  // A "Same as call N" group and a turn header.
  await stays(
    page,
    "Same as call N",
    await inside(16, (card) => card.getByTestId("call-seen").locator(":scope > button")),
  )
  await stays(page, "turn header", await centred(page, page.getByTestId("transcript-exchange").nth(3)))
  await stays(page, "turn header again", page.getByTestId("transcript-exchange").nth(3))
  // Expand everything, off screen at the top: what is at the top of the view stays; growth above it
  // must not push it.
  const anchor = await centred(page, cards.nth(10).getByTestId("call-header"), 0)
  await stays(page, "Expand everything", anchor, () =>
    page.getByRole("button", { name: "Expand everything" }).dispatchEvent("click"),
  )
  // A live refresh of the list (a call's update event).
  const header = await centred(page, cards.nth(12).getByTestId("call-header"), 0)
  await stays(page, "live refresh", header, async () => {
    pending.push({ payload: { type: "operator.call.updated", properties: { sessionID, callID: "call_14" } } })
    await page.waitForTimeout(800)
  })
})
