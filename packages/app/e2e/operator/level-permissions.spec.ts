import { expect, type Locator, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// Namespace and project permission levels (tool_prompt_from_permission.md §7): the Permissions section
// of a project and of a namespace record, with the shared level editor.

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

const pick = async (page: Page, trigger: Locator, option: string) => {
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  const list = await trigger.getAttribute("aria-controls")
  await page
    .locator(list ? `[id="${list}"] [data-component="menu-v2-item"]` : '[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${option}$`, "i") })
    .click()
}

const addLine = async (page: Page, scope: Locator, permission: string, pattern: string, action: string) => {
  const add = scope.getByTestId("permission-add")
  await add.getByRole("combobox", { name: "New rule's permission" }).fill(permission)
  await add.getByRole("textbox", { name: "New rule's pattern" }).fill(pattern)
  await pick(
    page,
    add.locator('[data-component="select-v2-root"][aria-label="New rule\'s action"] [data-component="select-v2"]'),
    action,
  )
  await add.getByRole("button", { name: "Add rule" }).click()
}

test("a project's Permissions: its own lines, locked for every level below", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/projects?project=${encodeURIComponent(directory)}&psec=permissions`)
  const section = page.getByTestId("level-permissions-project")
  await expect(section).toContainText(".opencode/opencode.jsonc")
  await expect(section.getByRole("row", { name: /question/ })).toContainText("OpenCode default")

  await section.getByRole("button", { name: "Edit permissions" }).click()
  // OpenCode's own lines can't be deleted in the OpenCode namespace.
  await expect(section.getByRole("button", { name: "Start from a blank slate" })).toHaveCount(0)
  await expect(section.getByRole("button", { name: "Delete question * at this level" })).toHaveCount(0)
  await addLine(page, section, "webfetch", "*", "Deny")
  await section
    .getByTestId("level-own")
    .getByRole("row", { name: /webfetch/ })
    .locator('[data-slot="checkbox-v2-control"]')
    .click()
  await section.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.levelWrites.length).toBe(1)
  expect(state.levelWrites[0]).toEqual({
    level: "project",
    body: {
      lines: [{ permission: "webfetch", pattern: "*", action: "deny" }],
      deleted: [],
      locks: [{ permission: "webfetch", pattern: "*" }],
    },
  })
  await expect(section.getByRole("row", { name: /webfetch/ })).toContainText("Locked by Project")
})

test("a project line inside a line the namespace locked is refused, with the reason", async ({ page }) => {
  const state = await mockOperator(page)
  state.levels.namespace = {
    lines: [{ permission: "webfetch", pattern: "*", action: "deny" }],
    deleted: [],
    locks: [{ permission: "webfetch", pattern: "*" }],
  }
  await page.goto(`/operator/projects?project=${encodeURIComponent(directory)}&psec=permissions`)
  const section = page.getByTestId("level-permissions-project")
  await expect(section.getByRole("row", { name: /webfetch/ })).toContainText("Locked by Namespace")
  await section.getByRole("button", { name: "Edit permissions" }).click()
  await addLine(page, section, "webfetch", "https://example.com/*", "Allow")
  await section.getByRole("button", { name: "Save", exact: true }).click()
  await expect(section.getByRole("alert")).toContainText("the namespace locks it")
})

test("a namespace's Permissions: a blank slate deletes OpenCode's lines and denies the rest", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.namespaces.push({ id: "acme", name: "Acme", purpose: "", createdAt: 1, updatedAt: 1 } as never)
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Namespaces" }).click()
  await settings.locator('[data-slot="settings-namespace"]', { hasText: "Acme" }).click()
  const record = page.getByRole("dialog").last()
  const section = record.getByTestId("level-permissions-namespace")
  await section.getByRole("button", { name: "Edit permissions" }).click()
  await section.getByRole("button", { name: "Start from a blank slate" }).click()
  await expect(section.getByTestId("level-inherited").getByRole("row", { name: /question/ })).toContainText(
    "deleted here",
  )
  await section.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.levelWrites.length).toBe(1)
  expect(state.levelWrites[0]!.level).toBe("namespace")
  expect(state.levelWrites[0]!.body.lines).toEqual([{ permission: "*", pattern: "*", action: "deny" }])
  expect(state.levelWrites[0]!.body.deleted).toHaveLength(3)
})
