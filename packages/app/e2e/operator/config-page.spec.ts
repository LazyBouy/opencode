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
  await expect(page.getByTestId("config-status")).toContainText("Using the Namespace config")
  await expect(page.getByTestId("config-status")).toContainText("This project has no config of its own.")
  const editor = page.getByRole("textbox", { name: "Edit settings" })
  await expect(editor).toHaveValue('{ "model": "opencode/big" }')
  // No Compare or "use again" without an own config.
  await expect(page.getByRole("button", { name: "Compare with Namespace config" })).toHaveCount(0)

  await editor.fill('{ "model": "opencode/small" }')
  await page.getByRole("button", { name: "Save", exact: true }).click()
  const question = page.getByRole("dialog").filter({ hasText: "Save as this project's own config?" })
  await expect(question).toContainText("The Namespace config (OpenCode) isn't changed")
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
  await expect(page.getByTestId("config-changed-since")).toHaveText("The Namespace config has changed since.")

  // The label names no namespace: its tooltip does, with its id and file.
  await expect(page.getByRole("button", { name: "Compare with Namespace config" })).toHaveAttribute(
    "title",
    /^OpenCode namespace · id opencode · .*opencode\/\.opencode\/opencode\.jsonc$/,
  )
  await page.getByRole("button", { name: "Compare with Namespace config" }).click()
  const compare = page.getByTestId("config-compare")
  await expect(compare).toContainText('{ "model": "opencode/small" }')
  await expect(compare).toContainText('{ "model": "opencode/big" }')
  await page.keyboard.press("Escape")
  await expect(compare).toHaveCount(0)

  await page.getByRole("button", { name: "Use the Namespace config again" }).click()
  const question = page.getByRole("dialog").filter({ hasText: "Use the Namespace config again?" })
  await expect(question).toContainText("moves to Trash")
  await question.getByRole("button", { name: "Use the Namespace config" }).click()
  await expect(page.getByTestId("config-status")).toContainText("Using the Namespace config")
  expect(state.writes.some((write) => write.url.includes("/operator/config/project/revert"))).toBe(true)
})

test("a config file git tracks is edited but never offered for removal", async ({ page }) => {
  const state = await mockOperator(page)
  state.projectConfig = { mode: "own", text: "{}", tracked: true }
  await page.goto(`/operator/config${dir}`)
  await expect(page.getByTestId("config-tracked")).toContainText("git tracks this file")
  await expect(page.getByRole("button", { name: "Compare with Namespace config" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Use the Namespace config again" })).toHaveCount(0)
})

test("Open the namespace's config goes to its Config section in Settings, where it is edited", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/config${dir}`)
  await page.getByRole("button", { name: "Open Namespace config" }).click()
  const section = page.getByTestId("namespace-config")
  await expect(section).toBeVisible()
  await expect(page.getByTestId("namespace-config-reach")).toContainText("1 projects use their own copies")
  const editor = section.getByRole("textbox", { name: "Config" })
  await expect(editor).toHaveValue('{ "model": "opencode/big" }')
  // The effective settings at the namespace's level, and where each comes from.
  await expect(section.getByTestId("config-effective")).toContainText('"model": "opencode/big"')
  const origins = section.getByTestId("config-origins")
  await expect(origins).toContainText("Namespace config")
  await expect(origins).toContainText("Environment (OPENCODE_CONFIG_CONTENT)")
  await expect(section.getByTestId("config-sources")).toContainText("/opencode/.opencode/opencode.jsonc")
  await editor.fill('{ "model": "opencode/medium" }')
  await section.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.namespaceConfigs.opencode).toBe('{ "model": "opencode/medium" }')
  // Read again after the save.
  await expect(section.getByTestId("config-effective")).toContainText('"model": "opencode/medium"')
})

test("Global's Config section says it is the base for every namespace", async ({ page }) => {
  const state = await mockOperator(page)
  state.namespaceConfigs.global = '{ "share": "manual", "provider": { "acme": { "options": { "apiKey": "sk-1" } } } }'
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Namespaces" }).click()
  await settings.locator('[data-slot="settings-namespace"]').first().click()
  await expect(page.getByTestId("namespace-config-reach")).toContainText("the base for every namespace")
  await expect(page.getByTestId("namespace-config")).toContainText("opencode/opencode.jsonc")
  // Global's effective settings: its base and the environment, secrets hidden.
  const effective = page.getByTestId("namespace-config").getByTestId("config-effective")
  await expect(effective).toContainText('"share": "manual"')
  await expect(effective).not.toContainText("sk-1")
  await expect(page.getByTestId("namespace-config").getByTestId("config-origins")).toContainText("Global base")
})

test("the config reference: every option, searched, with what this config sets and where", async ({ page }) => {
  await mockOperator(page)
  await page.route(
    (url) => url.pathname === "/config",
    (route) => route.fulfill({ json: { small_model: "opencode/small", model: "opencode/big" } }),
  )
  await page.goto(`/operator/config${dir}`)
  const reference = page.getByTestId("config-reference")
  // Closed until opened.
  await expect(reference.getByTestId("config-reference-body")).toHaveCount(0)
  await reference.getByRole("button", { name: "Config reference", exact: true }).click()
  await expect(reference.getByTestId("config-reference-count")).toContainText("17 of 17 options")

  await reference.getByRole("searchbox", { name: "Search options" }).fill("small_model")
  const option = reference.locator('[data-testid="config-option"][data-path="small_model"]')
  await expect(option).toContainText("A cheaper model for titles")
  await expect(option).toContainText("Default")
  await expect(option.getByTestId("config-option-set")).toContainText('small_model = "opencode/small"')
  await expect(option.getByTestId("config-option-set")).toContainText("Namespace config")
  await expect(option).toContainText("https://opencode.ai/docs/models")

  // Set in this config: only what the effective config has.
  await reference.getByRole("searchbox", { name: "Search options" }).fill("")
  await reference.getByRole("button", { name: "Set in this config" }).click()
  await expect(reference.getByTestId("config-reference-group")).toHaveCount(2)
  await reference.getByRole("button", { name: "All options" }).click()

  // A group of more than 10 options is paged; deprecated and the fork's own options say so.
  const experimental = reference.locator('[data-testid="config-reference-group"][data-group="experimental"]')
  await experimental.getByRole("button", { name: /experimental/ }).click()
  await expect(experimental.getByTestId("config-option")).toHaveCount(10)
  await expect(experimental.getByTestId("pager")).toContainText("1–10 of 11")
  await reference.locator('[data-testid="config-reference-group"][data-group="mode"]').getByRole("button").click()
  await expect(reference.locator('[data-path="mode"]')).toContainText("Deprecated")
  await reference.getByRole("button", { name: /operatorRecordCalls/ }).click()
  await expect(reference.locator('[data-path="operatorRecordCalls"]')).toContainText("Fork")

  // Remembered open; Full screen shows the same reference in an overlay.
  await page.reload()
  await expect(page.getByTestId("config-reference").getByTestId("config-reference-body")).toBeVisible()
  await page.getByTestId("config-reference").getByRole("button", { name: "Full screen" }).click()
  const overlay = page.getByTestId("overlay-frame")
  await overlay.getByRole("searchbox", { name: "Search options" }).fill("small")
  await expect(overlay.locator('[data-path="small_model"]').getByTestId("config-option-set")).toContainText(
    "opencode/small",
  )
})

test("a namespace's Config section has the config reference too", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/config${dir}`)
  await page.getByRole("button", { name: "Open Namespace config" }).click()
  const reference = page.getByTestId("namespace-config").getByTestId("config-reference")
  await expect(reference).toBeVisible()
  await reference.getByRole("button", { name: "Config reference", exact: true }).click()
  await reference.getByRole("searchbox", { name: "Search options" }).fill("model")
  await expect(reference.locator('[data-path="model"]').getByTestId("config-option-set")).toContainText(
    '"opencode/big"',
  )
})
