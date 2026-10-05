import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator, notes } from "./mock-operator"

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

test("a new session in a folder that is not a project asks first, and can start in a project instead", async ({
  page,
}) => {
  await mockOperator(page)
  await page.goto(`/${base64Encode(notes)}/session`)
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "This folder is not a project" })).toBeVisible()
  await expect(dialog).toContainText("is not part of one")

  await dialog.locator('[data-component="select-v2-root"][aria-label="Project"] [data-component="select-v2"]').click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^smoke-project/ })
    .click()
  await dialog.getByRole("button", { name: "Start there" }).click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/new-session\?draftId=/)
})

test("the folder can be made a project from the same question", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/${base64Encode(notes)}/session`)
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "This folder is not a project" })).toBeVisible()
  await dialog.getByRole("button", { name: "Make it a project" }).click()
  await expect(dialog).toBeHidden()
  expect(state.prompt.writes.at(-1)).toMatchObject({
    method: "POST",
    path: "/operator/project-settings/register",
    body: { directory: notes, git: false, namespace: "opencode" },
  })
})

test("a folder that is not a project can be made one from its overlay on Projects, as a git repository", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/projects")
  const row = page.getByRole("row", { name: /notes/ })
  await expect(row).toContainText("Not a project")
  await row.click()
  const overlay = page.getByRole("dialog")
  await overlay.getByRole("button", { name: "A git repository", exact: true }).click()
  await overlay.getByRole("button", { name: "Make it a project" }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]!.body).toEqual({ directory: notes, git: true, namespace: "opencode" })
  await expect(overlay.getByRole("button", { name: "Edit", exact: true })).toBeVisible()
  await overlay.getByRole("button", { name: "Close" }).click()
  await expect(row).not.toContainText("Not a project")
})
