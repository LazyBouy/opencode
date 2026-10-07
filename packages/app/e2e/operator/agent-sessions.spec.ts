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

test("an agent's sessions show its main and active ones; one can be made main, and the main one opened", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=sessions`)
  const main = page.getByTestId("agent-main-session")
  await expect(main).toContainText("No main session yet")
  const table = page.getByRole("table", { name: "Sessions" })
  await expect(table.getByRole("row", { name: /Fix the parser/ })).toContainText("Active")

  await table
    .getByRole("row", { name: /Fix the parser/ })
    .getByRole("button", { name: "Make main" })
    .click()
  await expect.poll(() => state.mainWrites).toEqual([{ agent: "build", sessionID: "ses_op_1" }])
  await expect(main).toContainText("Main session: Fix the parser")
  await expect(table.getByRole("row", { name: /Fix the parser/ })).toContainText("Main")

  await main.getByRole("button", { name: "Open main session" }).click()
  await expect(page).toHaveURL(/\/session\/ses_op_1$/)
})

test("with no chat open, Chats opens the default agent's main session in the default project", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("link", { name: "Chats" }).click()
  await expect(page).toHaveURL(/\/session\/ses_op_main$/)
  expect(state.mainOpens).toEqual([{ agent: "build", directory }])
})
