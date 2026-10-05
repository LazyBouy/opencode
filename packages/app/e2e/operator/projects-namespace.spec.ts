import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator, notes, workspace } from "./mock-operator"

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

// Picks an option of a select in the overlay. Inside a modal dialog the select's list is not in the
// accessibility tree, so options are found by their items.
const pick = async (page: Page, label: string, option: string) => {
  await page
    .getByRole("dialog")
    .locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`)
    .click()
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

test("a project opens in the overlay; Edit moves it after a check, then links its purpose and default profile", async ({
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

  // No actions on the rows: they are in the project's overlay.
  const row = page.getByRole("row", { name: /smoke-project/ })
  await expect(row).toContainText("OpenCode")
  await expect(row).toContainText("Release goal")
  await expect(row).toContainText("Namespace default (OpenCode)")
  await expect(row.getByRole("button")).toHaveCount(0)

  await row.click()
  const overlay = page.getByRole("dialog")
  await expect(overlay.getByRole("heading", { name: /smoke-project/ })).toBeVisible()
  await expect(overlay.getByRole("tab", { name: "OpenCode" })).toHaveAttribute("aria-selected", "true")
  for (const action of ["Edit", "New session", "Agents", "Config", "Sessions"])
    await expect(overlay.getByRole("button", { name: action, exact: true })).toBeVisible()

  await overlay.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(overlay.locator('[data-component="select-v2-root"][aria-label="Default profile"]')).toContainText(
    "Namespace default (OpenCode)",
  )
  await pick(page, "Namespace", "Acme")
  await overlay.getByRole("button", { name: "Check the move" }).click()
  await expect(overlay.getByRole("status")).toContainText("These are copied to Acme:")
  await expect(overlay.getByRole("status")).toContainText("Release goal")
  expect(state.prompt.projects[directory]!.namespace).toBe("opencode")
  await overlay.getByRole("button", { name: "Move", exact: true }).click()
  await expect(overlay.getByRole("button", { name: "Edit", exact: true })).toBeVisible()
  expect(state.prompt.writes.map((write) => write.body)).toEqual([
    { key: directory, namespace: "acme", dryRun: true },
    { key: directory, namespace: "acme" },
  ])
  await expect(overlay.locator('[data-component="record-fields"]')).toContainText("Acme")

  await overlay.getByRole("button", { name: "Edit", exact: true }).click()
  await pick(page, "Project Purpose", "Ship tools")
  await pick(page, "Default profile", "Spec")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect(overlay.getByRole("button", { name: "Edit", exact: true })).toBeVisible()
  expect(state.prompt.writes[2]!.body).toEqual({
    key: directory,
    purpose: "ship",
    // The project is in Acme now: Acme's own copy of the Spec profile.
    defaultProfile: "profile.spec",
  })
  await expect(overlay.locator('[data-component="record-fields"]')).toContainText("Ship tools")
  await overlay.getByRole("button", { name: "Close" }).click()
  await expect(row).toContainText("Acme")
  await expect(row).toContainText("Spec")
})

test("a folder outside git is its own row in OpenCode, marked when it is not a project", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/projects")
  const row = page.getByRole("row", { name: /notes/ })
  await expect(row).toContainText(notes)
  await expect(row).toContainText("no git")
  await expect(row).toContainText("Not a project")
  await expect(row).toContainText("OpenCode")
  await expect(page.getByText("Outside projects")).toHaveCount(0)

  await row.click()
  const overlay = page.getByRole("dialog")
  await expect(overlay).toContainText("it is not a project")
  await expect(overlay.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
  await expect(overlay.getByRole("button", { name: "Sessions", exact: true })).toBeVisible()
})

test("an added project stays in OpenCode unless another namespace is chosen", async ({ page }) => {
  const state = await mockOperator(page)
  acme(state)
  await page.goto("/operator/projects")
  await page.getByRole("button", { name: "Add project" }).click()
  const browser = page.getByRole("dialog")
  await browser.getByRole("list", { name: "Folders" }).getByRole("button", { name: "site" }).click()
  await browser.getByRole("button", { name: "Use this folder" }).click()

  const overlay = page.getByRole("dialog")
  await expect(overlay.getByRole("heading", { name: "Namespace for site" })).toBeVisible()
  await expect(overlay).toContainText("A new project goes to OpenCode")
  await pick(page, "Namespace", "Acme")
  await overlay.getByRole("button", { name: "Check the move" }).click()
  await expect(overlay.getByRole("status")).toContainText("Acme already has everything")
  await overlay.getByRole("button", { name: "Move", exact: true }).click()
  await expect(overlay.getByRole("button", { name: "Edit", exact: true })).toBeVisible()
  expect(state.prompt.projects[`${workspace}/site`]).toEqual({ namespace: "acme" })
})
