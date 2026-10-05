import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator, workspace } from "./mock-operator"

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

const pick = async (page: Page, label: string, option: string) => {
  await page
    .getByRole("dialog")
    .locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`)
    .click()
  // Inside a modal dialog the select's list is not in the accessibility tree, so pick by its items.
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${option.replace(/[()]/g, "\\$&")}$`) })
    .click()
}

const acme = (state: Awaited<ReturnType<typeof mockOperator>>) => {
  state.prompt.namespaces.push({ id: "acme", name: "Acme", purpose: "Build tools.", createdAt: 1, updatedAt: 1 })
  state.prompt.items.acme = {
    types: [],
    layers: [{ id: "ship", name: "Ship tools", type: "purpose", section: "purpose", text: "Ship.", origin: "user" }],
    groups: [],
    profiles: [],
  }
}

test("a project moves to another namespace after a check, then links its purpose and default profile", async ({
  page,
}) => {
  const state = await mockOperator(page)
  acme(state)
  state.prompt.items.opencode!.layers.push({
    id: "goal",
    name: "Release goal",
    type: "purpose",
    section: "purpose",
    text: "Release.",
    origin: "user",
  })
  state.prompt.projects[directory] = { namespace: "opencode", purpose: "goal" }
  await page.goto("/operator/projects")

  const row = page.getByRole("row", { name: /smoke-project/ })
  await expect(row).toContainText("OpenCode")
  await expect(row).toContainText("Release goal")
  await expect(row).toContainText("Namespace default (OpenCode)")

  await row.getByRole("button", { name: "Prompt settings of smoke-project" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Prompt settings: smoke-project" })).toBeVisible()
  await expect(dialog.locator('[data-component="select-v2-root"][aria-label="Default profile"]')).toContainText(
    "Namespace default (OpenCode)",
  )
  await pick(page, "Namespace", "Acme")
  await dialog.getByRole("button", { name: "Check the move" }).click()
  await expect(dialog.getByRole("status")).toContainText("These are copied to Acme:")
  await expect(dialog.getByRole("status")).toContainText("Release goal")
  expect(state.prompt.projects[directory]!.namespace).toBe("opencode")
  await dialog.getByRole("button", { name: "Move", exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(state.prompt.writes.map((write) => write.body)).toEqual([
    { key: directory, namespace: "acme", dryRun: true },
    { key: directory, namespace: "acme" },
  ])
  await expect(row).toContainText("Acme")

  await row.getByRole("button", { name: "Prompt settings of smoke-project" }).click()
  await pick(page, "Project Purpose", "Ship tools")
  await pick(page, "Default profile", "Spec")
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(state.prompt.writes[2]!.body).toEqual({
    key: directory,
    purpose: "ship",
    defaultProfile: "opencode:profile.spec",
  })
  await expect(row).toContainText("Ship tools")
  await expect(row).toContainText("Spec")
})

test("an added project stays in OpenCode unless another namespace is chosen", async ({ page }) => {
  const state = await mockOperator(page)
  acme(state)
  await page.goto("/operator/projects")
  await page.getByRole("button", { name: "Add project" }).click()
  const browser = page.getByRole("dialog")
  await browser.getByRole("list", { name: "Folders" }).getByRole("button", { name: "site" }).click()
  await browser.getByRole("button", { name: "Use this folder" }).click()

  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Namespace for site" })).toBeVisible()
  await expect(dialog).toContainText("A new project goes to OpenCode")
  await pick(page, "Namespace", "Acme")
  await dialog.getByRole("button", { name: "Check the move" }).click()
  await expect(dialog.getByRole("status")).toContainText("Acme already has everything")
  await dialog.getByRole("button", { name: "Move", exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(state.prompt.projects[`${workspace}/site`]).toEqual({ namespace: "acme" })
})
