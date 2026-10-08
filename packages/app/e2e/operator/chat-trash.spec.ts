import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// The chat's "…" → Move to Trash… (session_fixes_spec.md §1): the session and its subagents' sessions go
// to Trash, the tab closes, and a toast offers Undo and Open Trash. A failed move says why.

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

const session = `/server/${base64Encode(fixture.serverKey)}/session/${fixture.targetID}`

test("Move to Trash replaces Delete, moves the session with its folder, and Undo restores it", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(session)
  await page.getByRole("button", { name: "More options" }).first().click()
  await expect(page.getByRole("menuitem", { name: /^Delete/ })).toHaveCount(0)
  await page.getByRole("menuitem", { name: /Move to Trash/ }).click()
  const question = page.getByRole("dialog").filter({ hasText: "to Trash?" })
  await expect(question).toContainText('Move "')
  await question.getByRole("button", { name: "Yes, move to Trash" }).click()

  await expect.poll(() => state.trashWrites.length).toBe(1)
  expect(state.trashWrites[0]).toMatchObject({
    method: "POST",
    path: "/operator/trash/session",
    body: { sessionID: fixture.targetID },
    directory: fixture.directory,
  })
  await expect(page).not.toHaveURL(new RegExp(fixture.targetID))
  const toast = page.getByText("Moved to Trash")
  await expect(toast).toBeVisible()
  await page.getByRole("button", { name: "Undo" }).click()
  await expect.poll(() => state.trashWrites.map((write) => write.path)).toContain("/operator/trash/trash-1/restore")
})

test("a failed move says why and leaves the session where it was", async ({ page }) => {
  const state = await mockOperator(page)
  state.trashFail = "the disk is full"
  await page.goto(session)
  await page.getByRole("button", { name: "More options" }).first().click()
  await page.getByRole("menuitem", { name: /Move to Trash/ }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Yes, move to Trash" }).click()
  await expect(page.getByText("Couldn't move to Trash: the disk is full")).toBeVisible()
  await expect(page).toHaveURL(new RegExp(fixture.targetID))
})
