import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// Where namespaces and projects live (global_and_opencode_namespaces_spec.md §4, §5, §9): the working
// directory, Global as a namespace of its own, and projects flagged by where their folders are.

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

const namespaces = async (page: import("@playwright/test").Page) => {
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Namespaces" }).click()
  return settings
}

test("a blank working directory: Global and OpenCode are one namespace, until it is set", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.workingDir = undefined
  const settings = await namespaces(page)
  await expect(settings.getByTestId("working-dir")).toContainText("Blank: Global and OpenCode are one namespace")
  const rows = settings.locator('[data-slot="settings-namespace"]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("Global · OpenCode")

  // Global's capabilities are its own; its folder is fixed.
  await rows.first().click()
  const record = page.getByRole("dialog").last()
  await expect(record.getByTestId("namespace-inherit-global")).toHaveText("Always: Global's capabilities are its own")
  await expect(record.getByTestId("namespace-folder")).toHaveText("/home/me/.config/opencode")
  await record.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(record.getByRole("checkbox", { name: "Inherit global capabilities" })).toBeDisabled()
  await expect(record).toContainText("Global's folder is always ~/.config/opencode")
  await expect(record.getByLabel("Folder", { exact: true })).toHaveCount(0)
  await record.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.keyboard.press("Escape")

  // Setting it makes Global and OpenCode separate: Global first, OpenCode at <working directory>/opencode.
  await settings.getByRole("textbox", { name: "Working directory" }).fill("/workspace")
  await settings.getByRole("button", { name: "Set working directory" }).click()
  await expect(settings.getByTestId("working-dir-value")).toHaveText("/workspace")
  expect(state.prompt.workingDir).toBe("/workspace")
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText("Global")
  await expect(rows.nth(0)).not.toContainText("OpenCode")
  await expect(rows.nth(1)).toContainText("OpenCode")
  await rows.nth(1).click()
  await expect(page.getByRole("dialog").last().getByTestId("namespace-folder")).toHaveText("/workspace/opencode")
})

test("with a working directory, Global is listed first and a namespace elsewhere is not in place", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.namespaces.push({
    id: "acme",
    name: "Acme",
    purpose: "",
    folder: "/elsewhere/acme",
    createdAt: 1,
    updatedAt: 1,
  })
  state.prompt.items.acme = { types: [], layers: [], groups: [], profiles: [] }
  const settings = await namespaces(page)
  // Once set, the working directory is shown, not edited.
  await expect(settings.getByTestId("working-dir-value")).toHaveText("/workspace")
  await expect(settings.getByRole("button", { name: "Set working directory" })).toHaveCount(0)
  const rows = settings.locator('[data-slot="settings-namespace"]')
  await expect(rows.nth(0)).toContainText("Global")
  await expect(rows.nth(0)).toContainText("Built in")

  await settings.locator('[data-slot="settings-namespace"]', { hasText: "Acme" }).click()
  const record = page.getByRole("dialog").last()
  await expect(record.getByTestId("namespace-folder")).toContainText("/elsewhere/acme")
  await expect(record.getByTestId("namespace-folder")).toContainText("Not in place: it belongs at /workspace/acme")
})

test("projects outside OpenCode's folder, or not yet in their namespace's folder, are flagged", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.projects[directory]!.flag = "outside-opencode"
  await page.goto("/operator/projects")
  const rows = page.locator('[data-component="operator-table"] tbody tr')
  await expect(rows.filter({ hasText: "smoke-project" }).getByTestId("project-flag")).toHaveText(
    "Outside OpenCode's folder",
  )
  await expect(rows.filter({ hasText: "notes" }).getByTestId("project-flag")).toHaveCount(0)
})

test("a project outside OpenCode's folder moves into it, after a plan", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.projects[directory]!.flag = "outside-opencode"
  await page.goto(`/operator/projects?project=${encodeURIComponent(directory)}`)
  const overlay = page.getByRole("dialog")
  await overlay.getByRole("button", { name: "Move into OpenCode's folder" }).click()
  const move = page.getByRole("dialog").last()
  await expect(move.getByTestId("move-row")).toContainText("/workspace/opencode/")
  await expect(move.getByTestId("move-row")).toContainText("Ready")
  expect(state.prompt.moves.map((item) => item.path)).toEqual(["/operator/layout/plan"])
  expect(state.prompt.moves[0]!.body).toMatchObject({ kind: "project", project: directory, namespace: "opencode" })
  await move.getByRole("button", { name: "Move 1 folders" }).click()
  await expect(move.getByTestId("move-report")).toContainText("2 sessions re-linked")
  expect(state.prompt.moves[1]!.body).toMatchObject({ plan: "mp_1", items: ["mi_1"] })
})

test("a blocked folder can't be chosen, and says why", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.moveBlockers = [{ kind: "target-exists", message: "/workspace/opencode/x already exists" }]
  state.prompt.projects[directory]!.flag = "outside-opencode"
  await page.goto(`/operator/projects?project=${encodeURIComponent(directory)}`)
  await page.getByRole("dialog").getByRole("button", { name: "Move into OpenCode's folder" }).click()
  const move = page.getByRole("dialog").last()
  await expect(move.getByTestId("move-blocker")).toHaveText("/workspace/opencode/x already exists")
  await expect(move.getByRole("checkbox")).toBeDisabled()
  await expect(move.getByRole("button", { name: "Move 0 folders" })).toBeDisabled()
})

test("a namespace that isn't in place moves into place from its record", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.namespaces.push({
    id: "acme",
    name: "Acme",
    purpose: "",
    folder: "/elsewhere/acme",
    createdAt: 1,
    updatedAt: 1,
  })
  state.prompt.items.acme = { types: [], layers: [], groups: [], profiles: [] }
  const settings = await namespaces(page)
  await settings.locator('[data-slot="settings-namespace"]', { hasText: "Acme" }).click()
  const record = page.getByRole("dialog").last()
  await record.getByRole("button", { name: "Move into place" }).click()
  const move = page.getByRole("dialog").last()
  await expect(move.getByTestId("move-row")).toContainText("/workspace/acme")
  await move.getByRole("button", { name: "Move 1 folders" }).click()
  await expect(move.getByTestId("move-report")).toContainText("Moved")
  expect(state.prompt.namespaces.find((item) => item.id === "acme")!.folder).toBe("/workspace/acme")
})

test("after an upgrade, the folders to move wait for a confirmation; Not now moves nothing", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.namespaces.push({
    id: "acme",
    name: "Acme",
    purpose: "",
    folder: "/elsewhere/acme",
    createdAt: 1,
    updatedAt: 1,
  })
  state.prompt.items.acme = { types: [], layers: [], groups: [], profiles: [] }
  state.prompt.upgrade = { waiting: true, needsWorkingDir: false }
  await page.goto("/operator")
  const dialog = page.getByRole("dialog").filter({ hasText: "Folders to move after the upgrade" })
  await expect(dialog.getByTestId("move-row")).toContainText("/workspace/acme")
  await dialog.getByRole("button", { name: "Not now" }).click()
  await expect(dialog).toHaveCount(0)
  expect(state.prompt.moves.map((item) => item.path)).toEqual(["/operator/layout/plan"])
  expect(state.prompt.upgrade.waiting).toBe(false)
})

test("without a working directory there is no New namespace; it says why", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.workingDir = undefined
  const settings = await namespaces(page)
  await expect(settings.getByRole("button", { name: "New namespace", exact: true })).toBeDisabled()
  await expect(settings.getByRole("button", { name: "About New namespace" })).toBeVisible()
})
