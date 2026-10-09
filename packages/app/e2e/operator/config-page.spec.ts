import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// The project Config page and the namespace Config section (global_and_opencode_namespaces_spec.md §7,
// §8): one config per project, its own or its namespace's; the first save asks before copying.

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

const dir = `?dir=${encodeURIComponent(directory)}`

test("a project using its namespace's config asks before saving its own copy", async ({ page }) => {
  const state = await mockOperator(page)
  state.projectConfig = { mode: "namespace", text: "", tracked: false }
  await page.goto(`/operator/config${dir}`)
  await expect(page.getByTestId("config-status")).toContainText("Using OpenCode's config")
  await expect(page.getByTestId("config-status")).toContainText("This project has no config of its own.")
  const editor = page.getByRole("textbox", { name: "Edit settings" })
  await expect(editor).toHaveValue('{ "model": "opencode/big" }')
  // No Compare or "use again" without an own config.
  await expect(page.getByRole("button", { name: "Compare with OpenCode's config" })).toHaveCount(0)

  await editor.fill('{ "model": "opencode/small" }')
  await page.getByRole("button", { name: "Save", exact: true }).click()
  const question = page.getByRole("dialog").filter({ hasText: "Save as this project's own config?" })
  await expect(question).toContainText("OpenCode's config isn't changed")
  await question.getByRole("button", { name: "Cancel" }).click()
  await expect(question).toHaveCount(0)
  expect(state.projectConfig.mode).toBe("namespace")

  await page.getByRole("button", { name: "Save", exact: true }).click()
  await page.getByRole("button", { name: "Save as project config" }).click()
  await expect(page.getByTestId("config-status")).toContainText("Using this project's own config")
  await expect(page.getByTestId("config-status")).toContainText("Copied from OpenCode on")
  const writes = state.writes.filter((write) => write.url.includes("/operator/config/project"))
  expect(writes.map((write) => new URL(write.url).searchParams.get("confirmCopy"))).toEqual([null, null, "true"])
  expect(writes.at(-1)!.body).toEqual({ text: '{ "model": "opencode/small" }' })
  // The namespace's config is untouched.
  expect(state.namespaceConfigs.opencode).toBe('{ "model": "opencode/big" }')
})

test("an own copy: changed since, Compare, and using the namespace's config again", async ({ page }) => {
  const state = await mockOperator(page)
  state.projectConfig = {
    mode: "own",
    text: '{ "model": "opencode/small" }',
    tracked: false,
    copy: { namespace: "opencode", name: "OpenCode", copiedAt: Date.UTC(2026, 9, 8), changedSince: true },
  }
  await page.goto(`/operator/config${dir}`)
  await expect(page.getByTestId("config-changed-since")).toHaveText("OpenCode's config has changed since.")

  await page.getByRole("button", { name: "Compare with OpenCode's config" }).click()
  const compare = page.getByTestId("config-compare")
  await expect(compare).toContainText('{ "model": "opencode/small" }')
  await expect(compare).toContainText('{ "model": "opencode/big" }')
  await page.keyboard.press("Escape")
  await expect(compare).toHaveCount(0)

  await page.getByRole("button", { name: "Use OpenCode's config again" }).click()
  const question = page.getByRole("dialog").filter({ hasText: "Use OpenCode's config again?" })
  await expect(question).toContainText("moves to Trash")
  await question.getByRole("button", { name: "Use OpenCode's config" }).click()
  await expect(page.getByTestId("config-status")).toContainText("Using OpenCode's config")
  expect(state.writes.some((write) => write.url.includes("/operator/config/project/revert"))).toBe(true)
})

test("a config file git tracks is edited but never offered for removal", async ({ page }) => {
  const state = await mockOperator(page)
  state.projectConfig = { mode: "own", text: "{}", tracked: true }
  await page.goto(`/operator/config${dir}`)
  await expect(page.getByTestId("config-tracked")).toContainText("git tracks this file")
  await expect(page.getByRole("button", { name: "Compare with OpenCode's config" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Use OpenCode's config again" })).toHaveCount(0)
})

test("Open the namespace's config goes to its Config section in Settings, where it is edited", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/config${dir}`)
  await page.getByRole("button", { name: "Open OpenCode's config" }).click()
  const section = page.getByTestId("namespace-config")
  await expect(section).toBeVisible()
  await expect(page.getByTestId("namespace-config-reach")).toContainText("1 projects use their own copies")
  const editor = section.getByRole("textbox", { name: "Config" })
  await expect(editor).toHaveValue('{ "model": "opencode/big" }')
  await editor.fill('{ "model": "opencode/medium" }')
  await section.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.namespaceConfigs.opencode).toBe('{ "model": "opencode/medium" }')
})

test("Global's Config section says it is the base for every namespace", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Namespaces" }).click()
  await settings.locator('[data-slot="settings-namespace"]').first().click()
  await expect(page.getByTestId("namespace-config-reach")).toContainText("the base for every namespace")
  await expect(page.getByTestId("namespace-config")).toContainText("opencode/opencode.jsonc")
})
