import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator, pendingRequest } from "./mock-operator"

// Iteration 5 fixes, phase 3 (fixes_spec.md §3, §4.3): one reply card with four choices, wherever a
// request waits (the Permission Inbox, a session's record and details, the chat's dock), and every
// decision listed under Decided.

test("the reply card shows who asks and why, and Allow for session sends the edited pattern", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/inbox")
  await page.locator('[data-component="operator-ask"][data-request="per_op_1"]').click()
  const card = page.getByRole("dialog").getByTestId("reply-card")
  await expect(card).toContainText("Fix the parser")
  await expect(card).toContainText("build")
  await expect(card).toContainText("git push origin main")
  await expect(card.getByTestId("reply-asked-by")).toContainText("Asked by rule #1 * * ask")
  // OpenCode's built-in agent: no Allow for agent, and why.
  await expect(card.getByRole("button", { name: "Allow for agent" })).toBeDisabled()
  await expect(card).toContainText("OpenCode's built-in agent: allow it for the session")
  // The suggested pattern, edited.
  const pattern = card.getByRole("textbox", { name: "Rule pattern 1" })
  await expect(pattern).toHaveValue("git push *")
  await pattern.fill("git *")
  await card.getByRole("button", { name: "Allow for session" }).click()
  await expect.poll(() => state.decides.length).toBe(1)
  expect(state.decides[0]).toEqual({
    id: "per_op_1",
    body: { decision: "allow-session", patterns: ["git *"], via: "inbox" },
  })
  await expect(page.getByRole("dialog")).toBeHidden()

  // Decided: the decision, with every field a click away.
  await page.getByRole("button", { name: "Decided" }).click()
  const row = page.getByRole("row", { name: /Allow for session/ })
  await expect(row).toContainText("git push origin main")
  await row.click()
  const fields = page.getByTestId("decision-fields")
  await expect(fields).toContainText("Permission Inbox")
  await expect(fields).toContainText("me")
  await expect(fields).toContainText("Fix the parser")
})

test("Deny sends the note back to the agent", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/inbox?ask=per_op_1")
  const card = page.getByRole("dialog").getByTestId("reply-card")
  await card.getByRole("textbox", { name: "Note to the agent" }).fill("Push to a branch instead.")
  await card.getByRole("button", { name: "Deny" }).click()
  await expect.poll(() => state.decides.length).toBe(1)
  expect(state.decides[0]!.body).toEqual({ decision: "deny", note: "Push to a branch instead.", via: "inbox" })
})

test("a session's record and the chat's dock show the request with the four choices", async ({ page }) => {
  const permissions = [{ ...pendingRequest.request, sessionID: fixture.targetID }]
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    permissions: () => permissions,
  })
  const state = await mockOperator(page)
  state.pending = [
    { ...pendingRequest, request: { ...pendingRequest.request, sessionID: fixture.targetID } },
  ] as typeof state.pending

  // The chat: the dock offers the four choices instead of OpenCode's three.
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${fixture.targetID}`)
  const dock = page.getByTestId("dock-choices")
  await expect(dock).toBeVisible()
  for (const choice of ["Allow", "Allow for session", "Allow for agent", "Deny"])
    await expect(dock.getByRole("button", { name: choice, exact: true })).toBeVisible()
  await dock.getByRole("button", { name: "Allow", exact: true }).click()
  await expect.poll(() => state.decides.length).toBe(1)
  expect(state.decides[0]!.body).toEqual({ decision: "allow", via: "chat" })
})
