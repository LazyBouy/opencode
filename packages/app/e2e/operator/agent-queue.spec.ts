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

test("an agent's queue: where its messages go, queueing and steering a message, cancelling, and a message's record", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=queue`)

  // Where messages go when they name no session.
  const target = page.getByTestId("agent-queue-target")
  await target.getByRole("button", { name: "Active session" }).click()
  await expect.poll(() => state.targets.build).toBe("active")

  // A message waits; it is listed with its status.
  const form = page.getByTestId("agent-queue-form")
  await form.getByRole("textbox", { name: "Message" }).fill("Review the parser change")
  await form.getByRole("button", { name: "Queue message" }).click()
  await expect
    .poll(() => state.queueSends)
    .toEqual([{ agent: "build", text: "Review the parser change", priority: "normal", steer: false }])
  const table = page.getByRole("table", { name: "Queue" })
  const waiting = table.getByRole("row", { name: /Review the parser change/ })
  await expect(waiting).toContainText("Waiting")
  await expect(form.getByRole("textbox", { name: "Message" })).toHaveValue("")

  // A steering message goes in at once.
  await form.getByRole("textbox", { name: "Message" }).fill("Stop and run the tests")
  await form.getByText("Send now, even while it's working").click()
  await form.getByRole("button", { name: "Send now" }).click()
  await expect.poll(() => state.queueSends.at(-1)?.steer).toBe(true)
  await expect(table.getByRole("row", { name: /Stop and run the tests/ })).toContainText("Delivered")
  await expect(table.getByRole("row", { name: /Stop and run the tests/ })).toContainText("Steer")

  // A message's record, in an overlay; a waiting message can be cancelled.
  await waiting.click()
  const record = page.getByTestId("queue-record")
  await expect(record).toContainText("Review the parser change")
  await expect(record).toContainText("You")
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click()
  await expect(record).toHaveCount(0)
  await expect(waiting).toContainText("Cancelled")
  expect(state.queue[0]?.status).toBe("cancelled")
})

test("the queue shows each message's lane, sender and correlation; a reply links to the message it answers", async ({
  page,
}) => {
  const state = await mockOperator(page)
  const asked = {
    id: "msg_asked",
    project: directory,
    agent: "build",
    target: "main",
    text: "Can you review section 2?",
    priority: "normal",
    steer: false,
    sender: { kind: "user" },
    correlationID: "c_19",
    status: "delivered",
    lane: "sqlite",
    createdAt: Date.now() - 120_000,
    deliveredAt: Date.now() - 110_000,
    deliveredTo: "ses_op_1",
  }
  const reply = {
    id: "msg_reply",
    project: directory,
    agent: "build",
    target: "main",
    text: "Section 2 is ready.",
    priority: "high",
    steer: false,
    sender: { kind: "agent", agent: "writer", project: "web01" },
    correlationID: "c_19",
    replyTo: "msg_asked",
    status: "in memory",
    lane: "memory",
    createdAt: Date.now() - 5_000,
  }
  state.queue.push(asked, reply)
  await page.goto(`/operator/agents/build${dir}&tab=queue`)
  const table = page.getByRole("table", { name: "Queue" })
  const row = table.getByRole("row", { name: /Section 2 is ready/ })
  await expect(row).toContainText("Held in memory")
  await expect(row).toContainText("Memory")
  await expect(row).toContainText("writer (project web01)")
  await expect(row).toContainText("c_19")
  await expect(row).toContainText("Reply")
  await expect(table.getByRole("row", { name: /Can you review/ })).toContainText("SQLite")

  // The reply's record links to the message it answers; a held message can be cancelled.
  await row.click()
  const record = page.getByTestId("queue-record")
  await expect(record).toContainText("Memory")
  await expect(page.getByRole("dialog").getByRole("button", { name: "Cancel" })).toBeVisible()
  await record.getByRole("button", { name: /Can you review section 2/ }).click()
  await expect(page.getByTestId("queue-record")).toContainText("Can you review section 2?")
})
