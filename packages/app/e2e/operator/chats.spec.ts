import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

const sessionID = "ses_smoke_target"
const sessionPage = `/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    // The chat's sessions run as build.
    sessions: fixture.sessions.map((session) => ({ ...session, agent: "build" })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
})

test("Chats returns to the chat tab used last instead of opening the main session", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(sessionPage)
  await expect(page.getByTestId("session-picker")).toBeVisible()
  await page.goto("/operator")
  const chats = page.getByRole("navigation", { name: "Operator" }).getByRole("link", { name: "Chats" })
  await chats.click()
  await expect(page).toHaveURL(new RegExp(`/session/${sessionID}$`))
  expect(state.mainOpens).toEqual([])
  await expect(chats).toHaveAttribute("data-active", "")
})

test("the agent's sessions are a menu at the top left of the chat: open another, or start a new one", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(sessionPage)
  const picker = page.getByTestId("session-picker")
  await expect(picker).toHaveText(/build/)
  await picker.click()
  const menu = page.getByTestId("session-picker-menu")
  await expect(menu).toContainText("build's sessions in")
  // Only the agent's sessions: build's, not plan's.
  await expect(menu).toContainText("Fix the parser")
  await expect(menu).not.toContainText("Plan the release")
  await menu.getByRole("menuitemradio", { name: /Fix the parser/ }).click()
  await expect(page).toHaveURL(/\/session\/ses_op_1$/)

  // Both stay open as tabs: one agent can have several sessions open.
  await page.goto(sessionPage)
  await page.getByTestId("session-picker").click()
  await page.getByTestId("session-picker-menu").getByRole("menuitem", { name: "New session with build" }).click()
  await expect.poll(() => state.sessionCreates.length).toBe(1)
  expect(state.sessionCreates[0]?.body).toMatchObject({ agent: "build" })
  await expect(page).toHaveURL(/\/session\/ses_op_new$/)
})
