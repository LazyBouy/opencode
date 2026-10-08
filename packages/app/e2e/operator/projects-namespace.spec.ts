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
  state.prompt.namespaces.push({
    id: "acme",
    name: "Acme",
    purpose: "Build tools.",
    folder: `${workspace}/apps`,
    createdAt: 1,
    updatedAt: 1,
  })
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
  // An open project has its own sections, and "‹ All projects" back to the namespaces.
  await expect(overlay.getByRole("button", { name: "All projects" })).toBeVisible()
  for (const section of ["Overview", "Agents", "Sessions", "Config", "Prompt", "Members and groups"])
    await expect(overlay.getByRole("tab", { name: section, exact: true })).toBeVisible()
  await expect(overlay.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true")
  for (const action of ["Edit project", "New session", "Copy project", "Delete"])
    await expect(overlay.getByRole("button", { name: action, exact: true })).toBeVisible()

  await overlay.getByRole("tab", { name: "Prompt", exact: true }).click()
  await overlay.getByRole("button", { name: "Prompt settings", exact: true }).click()
  await expect(overlay.locator('[data-component="select-v2-root"][aria-label="Default profile"]')).toContainText(
    "Namespace default (OpenCode)",
  )
  await pick(page, "Namespace", "Acme")
  await overlay.getByRole("button", { name: "Check the move" }).click()
  await expect(overlay.getByRole("status")).toContainText("These are copied to Acme:")
  await expect(overlay.getByRole("status")).toContainText("Release goal")
  expect(state.prompt.projects[directory]!.namespace).toBe("opencode")
  await overlay.getByRole("button", { name: "Move", exact: true }).click()
  await expect(overlay.getByRole("button", { name: "Prompt settings", exact: true })).toBeVisible()
  expect(state.prompt.writes.map((write) => write.body)).toEqual([
    { key: directory, namespace: "acme", dryRun: true },
    { key: directory, namespace: "acme" },
  ])
  await expect(overlay.locator('[data-component="record-fields"]')).toContainText("Acme")

  await overlay.getByRole("button", { name: "Prompt settings", exact: true }).click()
  await pick(page, "Project Purpose", "Ship tools")
  await pick(page, "Default profile", "Spec")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect(overlay.getByRole("button", { name: "Prompt settings", exact: true })).toBeVisible()
  expect(state.prompt.writes[2]!.body).toEqual({
    key: directory,
    purpose: "ship",
    // The project is in Acme now: Acme's own copy of the Spec profile.
    defaultProfile: "profile.spec",
  })
  // The goal is the linked Project Purpose layer's text, in the project's record.
  await overlay.getByRole("tab", { name: "Members and groups", exact: true }).click()
  await expect(overlay.getByTestId("project-goal")).toContainText("Ship.")
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
  await expect(overlay.getByRole("tab", { name: "Sessions", exact: true })).toBeVisible()
  await expect(overlay.getByRole("tab", { name: "Config", exact: true })).toHaveCount(0)
})

test("Add project asks for the namespace, starts in its folder and puts the new project there", async ({ page }) => {
  const state = await mockOperator(page)
  acme(state)
  await page.goto("/operator/projects")
  await page.getByRole("button", { name: "Add project" }).click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^Acme$/ })
    .click()
  const browser = page.getByRole("dialog")
  // Acme's folder is where its new projects go.
  await expect(browser.getByRole("navigation", { name: "Folder path" })).toContainText("apps")
  await browser.getByRole("textbox", { name: "New folder name" }).fill("tool")
  await browser.getByRole("button", { name: "Create folder" }).click()
  await expect(browser.getByRole("navigation", { name: "Folder path" })).toContainText("tool")
  await browser.getByRole("button", { name: "Use this folder" }).click()
  await expect.poll(() => state.prompt.projects[`${workspace}/apps/tool`]).toEqual({ namespace: "acme" })
})

test("a project outside its namespace's folder says so on its record", async ({ page }) => {
  const state = await mockOperator(page)
  acme(state)
  state.prompt.projects[directory] = { namespace: "acme" }
  await page.goto("/operator/projects")
  await page.getByRole("row", { name: /smoke-project/ }).click()
  const overlay = page.getByRole("dialog")
  await expect(overlay).toContainText("outside the namespace folder")
  state.prompt.namespaces.find((item) => item.id === "acme")!.folder = directory
  await page.reload()
  await expect(page.getByRole("dialog")).toContainText("Folder")
  await expect(page.getByRole("dialog")).not.toContainText("outside the namespace folder")
})

test("a project's record: goal, description, status, members, manager and groups", async ({ page }) => {
  const state = await mockOperator(page)
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
  await page.getByRole("row", { name: /smoke-project/ }).click()
  const overlay = page.getByRole("dialog")
  await expect(overlay.getByTestId("project-goal")).toContainText("Release.")
  await expect(overlay.getByTestId("project-members")).toContainText("Every agent can take part")

  await overlay.getByRole("button", { name: "Edit project", exact: true }).click()
  const form = overlay.getByTestId("project-record-form")
  await form.getByRole("textbox").first().fill("Release the parser.")
  const members = form.getByTestId("project-members-edit")
  await members.getByText("build", { exact: true }).click()
  await members.getByText("reviewer", { exact: true }).click()
  await pick(page, "Manager", "build")
  await form.getByRole("button", { name: "Add group" }).click()
  await form.getByRole("textbox", { name: "Group name" }).fill("Reviewers")
  await form.locator('[data-slot="operator-group-edit"]').getByText("reviewer", { exact: true }).click()
  await form.getByRole("button", { name: "Save", exact: true }).click()

  await expect.poll(() => state.projectRecordWrites.length).toBe(1)
  expect(state.projectRecordWrites[0]).toMatchObject({
    key: directory,
    status: "active",
    manager: "build",
    members: ["build", "reviewer"],
    groups: [{ name: "Reviewers", members: ["reviewer"] }],
  })
  // The goal was changed in its layer.
  expect(state.prompt.items.opencode!.layers.find((layer) => layer.id === "goal")?.text).toBe("Release the parser.")
  await expect(overlay.getByTestId("project-members")).toContainText("build, reviewer")
})

test("a namespace's default project is its first project until another is chosen", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.projects[`${workspace}/site`] = { namespace: "opencode" }
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Namespaces" }).click()
  await settings.locator('[data-slot="settings-namespace"]', { hasText: "OpenCode" }).click()
  const record = page.getByRole("dialog").last()
  await expect(record.getByTestId("namespace-default-project")).toHaveText("First project (SmokeProject)")

  await record.getByRole("button", { name: "Edit", exact: true }).click()
  await record
    .locator('[data-component="select-v2-root"][aria-label="Default project"] [data-component="select-v2"]')
    .click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^site$/ })
    .click()
  await record.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.namespaces[0]!.defaultProject).toBe(`${workspace}/site`)
  await expect(record.getByTestId("namespace-default-project")).toHaveText("site")
})

test("a new namespace can leave out the global capabilities; OpenCode always gets them", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Namespaces" }).click()
  await settings.locator('[data-slot="settings-namespace"]', { hasText: "OpenCode" }).click()
  const record = page.getByRole("dialog").last()
  await expect(record.getByTestId("namespace-inherit-global")).toHaveText("Always, for OpenCode")
  await record.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(record.getByRole("checkbox", { name: "Inherit global capabilities" })).toBeDisabled()
  await record.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(record.getByTestId("namespace-view")).toBeVisible()
  // Focus is back in the record, so Escape closes it and leaves Settings open.
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "OpenCode" })).toHaveCount(0)
  await expect(settings).toBeVisible()

  await settings.getByRole("button", { name: "New namespace" }).click()
  const created = page.getByRole("dialog").last()
  await created.getByLabel("Name", { exact: true }).fill("Plain")
  await created.getByLabel("Folder", { exact: true }).fill(`${workspace}/plain`)
  await created
    .locator('[data-slot="checkbox-v2"]', { hasText: "Inherit global capabilities" })
    .locator('[data-slot="checkbox-v2-control"]')
    .click()
  await created.getByRole("button", { name: "Create namespace" }).click()
  await expect.poll(() => state.prompt.namespaces.find((item) => item.id === "plain")?.inheritGlobal).toBe(false)
  await expect(created.getByTestId("namespace-inherit-global")).toContainText("No: only OpenCode's built-ins")
})

test("a new namespace starts with the capabilities ticked in its Capabilities step", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Namespaces" }).click()
  await settings.getByRole("button", { name: "New namespace" }).click()
  const record = page.getByRole("dialog").last()
  await record.getByLabel("Name", { exact: true }).fill("Acme")
  await record.getByLabel("Folder", { exact: true }).fill(`${workspace}/acme`)
  const items = record.getByTestId("namespace-start-items")
  // From OpenCode: its own layer's items and its copyable built-ins, all ticked, and its settings.
  await expect(items.getByRole("checkbox", { name: "/deploy" })).toBeChecked()
  await expect(items.getByRole("checkbox", { name: "/review" })).toBeChecked()
  await expect(items.getByRole("checkbox", { name: "build" })).toBeChecked()
  await expect(items.getByRole("checkbox", { name: "instructions" })).toBeChecked()
  await expect(items.getByRole("checkbox", { name: "read" })).toHaveCount(0)
  await items
    .locator('[data-slot="checkbox-v2"]', { hasText: "/review" })
    .locator('[data-slot="checkbox-v2-control"]')
    .click()
  await expect(record.getByTestId("namespace-start-summary")).toContainText(`Copies 3 into ${workspace}/acme/.opencode`)
  await record.getByRole("button", { name: "Create namespace" }).click()
  await expect
    .poll(() => state.capabilityWrites.find((write) => write.action === "seed")?.body)
    .toEqual({
      from: "opencode",
      to: "acme",
      items: [
        { kind: "command", name: "deploy" },
        { kind: "agent", name: "build" },
      ],
      config: ["instructions"],
    })
})
