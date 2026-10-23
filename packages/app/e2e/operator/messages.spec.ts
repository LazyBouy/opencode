import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// SPEC-0023 §10.2, §14: a message another agent sent is marked as a message, with its sender and its record; a
// `ping` call's card shows its target and status, the time it has waited, then the reply.

const sessionID = "ses_smoke_target"
const pending: unknown[] = []
let assistantID = ""

const waitingCard = () => ({
  verb: "send",
  target: "agent writer",
  status: "waiting",
  messages: [{ id: "msg_out", to: "writer", status: "in memory" }],
  correlationID: "c_19",
  wait: { since: Date.now() - 42_000, timeout: 120, from: "writer" },
})
const pingPart = (state: Record<string, unknown>) => ({
  id: "prt_zz_ping",
  sessionID,
  messageID: assistantID,
  type: "tool",
  tool: "ping",
  callID: "call_ping",
  state,
})

function withMessages(id: string, limit: number, before?: string) {
  const page = pageMessages(id, limit, before) as {
    items: Array<{ info: { id: string; role: string }; parts: unknown[] }>
  }
  if (id !== sessionID || before) return page
  const items = structuredClone(page.items)
  const user = items.findLast((message) => message.info.role === "user")
  const text = user?.parts.find((part) => (part as { type: string }).type === "text") as
    | { text: string; metadata?: unknown }
    | undefined
  if (text) {
    text.text = "Message from writer (project repo) · high · correlation c_19 · id msg_in:\nReview section 2."
    text.metadata = {
      message: {
        id: "msg_in",
        agent: "build",
        folder: fixture.directory,
        from: { kind: "agent", agent: "writer", session: "ses_writer" },
        correlationID: "c_19",
        priority: "high",
      },
    }
  }
  const assistant = items.findLast((message) => message.info.role === "assistant")!
  assistantID = assistant.info.id
  assistant.parts.push(
    pingPart({
      status: "running",
      input: { verb: "send", target: { type: "agent", id: "writer" }, message: { body: "Done?" }, wait: true },
      title: "Waiting for a reply from writer",
      metadata: { ping: waitingCard() },
      time: { start: 1 },
    }),
  )
  return { ...page, items }
}

test.use({ viewport: { width: 1400, height: 1800 } })

test.beforeEach(async ({ page }) => {
  pending.length = 0
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: withMessages,
    events: () => pending.splice(0),
    eventRetry: 200,
  })
})

test("a message from another agent is marked with its sender and opens its record", async ({ page }) => {
  const state = await mockOperator(page)
  state.queue.push({
    id: "msg_in",
    project: fixture.directory,
    agent: "build",
    target: "main",
    text: "Review section 2.",
    priority: "high",
    steer: false,
    sender: { kind: "agent", agent: "writer", sessionID: "ses_writer" },
    correlationID: "c_19",
    status: "delivered",
    lane: "memory",
    createdAt: 1,
    deliveredAt: 2,
    deliveredTo: sessionID,
  })
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  const mark = page.getByTestId("message-mark")
  await expect(mark).toContainText("Message from writer")
  await expect(mark).toContainText("High")
  await mark.getByRole("button", { name: "Open its record" }).click()
  const record = page.getByRole("dialog").getByTestId("queue-record")
  await expect(record).toContainText("Review section 2.")
  await expect(record).toContainText("c_19")
})

test("a ping call that waits shows the time waited, then the reply", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  const card = page.getByTestId("ping-card")
  await expect(card).toContainText("ping · send")
  await expect(card).toContainText("agent writer")
  await expect(card.getByTestId("ping-waiting")).toHaveText(/Waiting for a reply from writer · 0:4\d/)
  await expect(card).toContainText("msg_out")

  pending.push({
    directory: fixture.directory,
    payload: {
      type: "message.part.updated",
      properties: {
        part: pingPart({
          status: "completed",
          input: { verb: "send", target: { type: "agent", id: "writer" }, message: { body: "Done?" }, wait: true },
          output: "msg_out → writer: in memory\ncorrelation c_19\nReply from writer (msg_back):\nYes, merged.",
          title: "reply from writer",
          metadata: {
            ping: {
              ...waitingCard(),
              status: "replied",
              reply: { id: "msg_back", from: "writer", text: "Yes, merged." },
            },
          },
          time: { start: 1, end: 2 },
        }),
      },
    },
  })
  await expect(card.getByTestId("ping-status")).toHaveText("Replied")
  await expect(card.getByTestId("ping-waiting")).toHaveCount(0)
  await expect(card.getByTestId("ping-reply")).toContainText("Reply from writer")
  await expect(card.getByTestId("ping-reply")).toContainText("Yes, merged.")
})
