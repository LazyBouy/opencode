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
