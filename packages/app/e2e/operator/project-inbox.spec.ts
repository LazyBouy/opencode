import { expect, test } from "@playwright/test"
import { directory, mockOperator } from "./mock-operator"

// SPEC-0023 §10.1, §14 on mocks: the Project inbox's tabs (Messages, Waiting, Dead letter, Rules, Settings), a
// message's record with its trail and copies, the dead letter's actions, adding, reordering and testing rules,
// the warning when "Replies go to their sender" is missing, the unmatched setting, and Settings → Messaging.

const inboxPage = `/operator/project-inbox?project=proj_smoke_timeline&dir=${encodeURIComponent(directory)}`

test("the tabs list what entered the inbox, what waits for the manager, and the dead letters", async ({ page }) => {
  await mockOperator(page)
  await page.goto(inboxPage)
  await expect(page.getByRole("heading", { name: /Project inbox · SmokeProject/ })).toBeVisible()
  const rows = page.getByTestId("inbox-message")
  await expect(rows).toHaveCount(3)
  await expect(page.getByTestId("inbox-messages")).toContainText("rule Docs")

  const tabs = page.getByTestId("inbox-tabs")
  await tabs.getByRole("tab", { name: "Waiting" }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("With the manager")
  await tabs.getByRole("tab", { name: "Dead letter" }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("Dead letter")

  // A routed message's record: its trail and where its copies went.
  await tabs.getByRole("tab", { name: "Messages" }).click()
  await rows.filter({ hasText: "rule Docs" }).click()
  const record = page.getByTestId("inbox-record")
  await expect(record).toContainText("Review the release notes")
  await expect(record).toContainText("The agent build")
  await expect(page.getByTestId("inbox-copies")).toContainText("plan")
  await expect(page.getByTestId("inbox-trail")).toContainText("entered the Project inbox")

  // Its conversation: the messages sharing its correlation id, and the sessions involved.
  await page.getByRole("dialog").getByRole("button", { name: "Conversation" }).click()
  const conversation = page.getByTestId("conversation")
  await expect(conversation.getByTestId("conversation-message")).toHaveCount(1)
  await expect(conversation).toContainText("Review the release notes")
  await expect(conversation.getByTestId("conversation-sessions")).toContainText("ses_op_1 title")
  await expect(conversation.getByTestId("conversation-sessions")).toContainText("ses_op_2 title")
})

test("a dead letter is forwarded, routed again, broadcast or deleted to Trash", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`${inboxPage}&itab=dead`)
  await page.getByTestId("inbox-message").first().click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Route again" }).click()
  await expect.poll(() => state.inbox.writes.map((write) => write.action)).toContain("route-again")
  await expect(page.getByTestId("inbox-trail")).toContainText("routed again")

  await dialog.getByRole("button", { name: "Forward to…" }).click()
  const forward = page.getByTestId("inbox-forward")
  await forward.getByRole("textbox", { name: "Its name or id" }).fill("build")
  await forward.getByRole("button", { name: "Forward", exact: true }).click()
  await expect
    .poll(() => state.inbox.writes.find((write) => write.action === "forward")?.body)
    .toEqual({ to: [{ type: "agent", id: "build" }] })
  await expect(page.getByTestId("inbox-record")).toContainText("forwarded by you")

  // Another dead letter: deleted, after asking, to Trash.
  state.inbox.messages.push({
    ...state.inbox.messages[1]!,
    id: "msg_dead_2",
    status: "dead letter",
    body: { type: "text", text: "Lost" },
  })
  await page.goto(`${inboxPage}&itab=dead`)
  await page.getByTestId("inbox-message").filter({ hasText: "Lost" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click()
  await page.getByRole("button", { name: "Yes, move to Trash" }).click()
  await expect
    .poll(() => state.inbox.writes.some((write) => write.action === "remove" && write.id === "msg_dead_2"))
    .toBe(true)
})

test("rules: added in a form, reordered, tested; the warning when replies have no rule", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`${inboxPage}&itab=rules`)
  const list = page.getByTestId("inbox-rule")
  await expect(list).toHaveCount(2)

  // Add a rule: words to match, forwarded to an agent.
  await page.getByRole("button", { name: "Add rule" }).click()
  const form = page.getByTestId("inbox-rule-form")
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Billing")
  await form.getByRole("textbox", { name: "Text contains" }).fill("billing")
  await form.getByRole("button", { name: "Add a recipient" }).click()
  await form.getByTestId("inbox-rule-targets").getByRole("textbox", { name: "Its name or id" }).fill("build")
  await form.getByRole("button", { name: "Save" }).click()
  await expect(list).toHaveCount(3)
  expect(state.inbox.rules.at(-1)).toMatchObject({
    name: "Billing",
    match: { contains: "billing" },
    action: { kind: "forward", to: [{ type: "agent", id: "build" }] },
  })

  // Reordered: Billing up, before Docs.
  await page.getByRole("button", { name: "Move Billing up" }).click()
  await expect.poll(() => state.inbox.rules.map((rule) => rule.id)).toEqual(["replies", "r3", "docs"])

  // Test: which rule takes a sample.
  const test_ = page.getByTestId("inbox-rules-test")
  await test_.getByRole("textbox", { name: "Text", exact: true }).fill("Who owns the billing page?")
  await test_.getByRole("button", { name: "Test" }).click()
  await expect(page.getByTestId("inbox-rules-test-result")).toContainText("Billing")

  // Without "Replies go to their sender": the warning, and its button puts it back first.
  await page.locator('[data-rule="replies"]').getByRole("button", { name: "Delete" }).click()
  await page.getByRole("button", { name: "Delete" }).last().click()
  await expect(page.getByTestId("inbox-rules-replies-missing")).toBeVisible()
  await page.getByRole("button", { name: "Add it first" }).click()
  await expect.poll(() => state.inbox.rules[0]?.id).toBe("replies")
  await expect(page.getByTestId("inbox-rules-replies-missing")).toHaveCount(0)
})

test("Settings: unmatched messages; Settings → Messaging's limits and backends", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`${inboxPage}&itab=settings`)
  const settings = page.getByTestId("inbox-settings")
  await expect(settings).toContainText("No manager")
  await expect(settings).toContainText("SQLite")
  await settings.getByTestId("inbox-unmatched").getByRole("button", { name: "Broadcast" }).click()
  await expect.poll(() => state.inbox.unmatched).toBe("broadcast")

  await page.getByRole("button", { name: "Settings → Messaging" }).click()
  const messaging = page.getByTestId("messaging-settings")
  await expect(page.getByTestId("messaging-status")).toContainText("In-process · 2 held now · at most 200 a session")
  await expect(page.getByTestId("messaging-status")).toContainText("Not configured")
  const perMinute = messaging.getByRole("textbox", { name: "Sends a minute" })
  await expect(perMinute).toHaveValue("30")
  await perMinute.fill("10")
  await messaging.getByRole("button", { name: "Save" }).click()
  await expect.poll(() => state.inbox.settings.perMinute).toBe(10)
})

test("the project's overlay shows its inbox's counts and opens the page; New message goes to the inbox", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/projects?project=${encodeURIComponent(directory)}&psec=inbox`)
  const section = page.getByTestId("project-inbox-section")
  await expect(section).toContainText("Dead letter")
  await page.getByTestId("project-inbox-open").click()
  await expect(page).toHaveURL(/\/operator\/project-inbox\?project=/)

  await page.getByRole("button", { name: "New message" }).click()
  const form = page.getByTestId("inbox-new-message")
  await form.getByRole("textbox").first().fill("Can someone look at the build?")
  await form.getByRole("button", { name: "Send to the inbox" }).click()
  await expect
    .poll(() => state.inbox.writes.find((write) => write.action === "enter")?.body)
    .toMatchObject({
      text: "Can someone look at the build?",
    })
  // The new message's record opens.
  await expect(page.getByTestId("inbox-record")).toContainText("Can someone look at the build?")
})
