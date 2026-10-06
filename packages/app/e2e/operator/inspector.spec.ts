import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator, pendingRequest } from "./mock-operator"

const sessionID = "ses_smoke_target"

test("the session details panel shows the open session's approvals and subagents", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  const state = await mockOperator(page)
  state.pending = [{ ...pendingRequest, request: { ...pendingRequest.request, sessionID } }]

  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  await page.getByRole("button", { name: "Session details" }).click()
  const panel = page.getByRole("complementary", { name: "Session details" })
  await expect(panel).toBeVisible()

  await panel.getByRole("tab", { name: "Approvals (1)" }).click()
  await expect(panel.locator('[data-component="operator-ask"]')).toContainText("git push origin main")
  await panel.getByRole("tab", { name: "Subagents (1)" }).click()
  await panel.getByRole("button", { name: "Explore the codebase" }).click()
  await expect(page).toHaveURL(/\/session\/ses_op_child$/)
})

test("the session details button only appears on session pages", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await mockOperator(page)
  await page.goto("/operator")
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Session details" })).toHaveCount(0)
})

test("the session details panel edits the session's own permissions, widened for the editor", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await mockOperator(page)
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  await page.getByRole("button", { name: "Session details" }).click()
  const panel = page.getByRole("complementary", { name: "Session details" })
  const narrow = (await panel.boundingBox())!.width
  await panel.getByRole("tab", { name: "Permissions" }).click()
  await expect(panel.getByTestId("session-permissions")).toContainText("Same as the agent until you change it here.")
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(narrow + 100)
})
