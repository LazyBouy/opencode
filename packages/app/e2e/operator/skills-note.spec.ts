import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// Capabilities → Skills: "How skills reach an agent" (skills_rules_note_spec.md).

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

test("the skills note is closed by default, opens with its four sections, copies its examples and is remembered", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await mockOperator(page)
  await page.goto(`/operator/capabilities?dir=${encodeURIComponent(directory)}&tab=skills`)
  const note = page.locator('[data-component="operator-skills-note"]')
  await expect(note).toContainText(
    "How skills reach an agent: where OpenCode finds skills, and how to give an agent only some of them",
  )
  await expect(note.getByRole("heading")).toHaveCount(0)

  await note.locator("summary").click()
  await expect(note.getByRole("heading")).toHaveText([
    "Where OpenCode finds skills",
    "How an agent gets them",
    "Giving one agent only some skills",
    "Good to know",
  ])
  await note.getByRole("button", { name: "Copy" }).last().click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    '"permission": { "skill": { "*": "allow", "experimental-*": "deny" } }',
  )

  // Remembered after a reload.
  await page.reload()
  await expect(note.getByRole("heading")).toHaveCount(4)

  // The links: an agent's Permissions, by name, and Config.
  await note.getByRole("button", { name: "open the agent's Permissions tab" }).click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^build$/ })
    .click()
  await expect(page).toHaveURL(/\/operator\/agents\?.*atab=permissions/)
  await expect(page).toHaveURL(/agent=build/)

  await page.goBack()
  await note.getByRole("button", { name: "config", exact: true }).click()
  await expect(page).toHaveURL(/\/operator\/config/)
})
