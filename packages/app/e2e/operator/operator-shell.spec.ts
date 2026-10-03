import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

const claude = {
  id: "claude",
  name: "Claude Code",
  transports: ["cli"],
  enabled: true,
  available: true,
  binary: "/usr/local/bin/claude",
  version: "2.1.123",
}

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

test("the sidebar opens operator pages and marks the current one", async ({ page }) => {
  await page.goto("/")
  const nav = page.getByRole("navigation", { name: "Operator" })
  await expect(nav).toBeVisible()

  await nav.getByRole("link", { name: "Agents" }).click()
  await expect(page).toHaveURL(/\/operator\/agents$/)
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible()
  await expect(nav.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page")
  await expect(nav.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current", "page")

  await nav.getByRole("link", { name: "Dashboard" }).click()
  await expect(page).toHaveURL(/\/operator$/)
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible()

  await nav.getByRole("link", { name: "Chat" }).click()
  await expect(page).toHaveURL(/\/$/)
})

test("an unknown operator page falls back to the dashboard", async ({ page }) => {
  await page.goto("/operator/nope")
  await expect(page).toHaveURL(/\/operator$/)
})

test("chat pages show the sidebar as an icon rail until it is expanded", async ({ page }) => {
  await page.goto("/")
  const nav = page.getByRole("navigation", { name: "Operator" })
  await expect(nav).toHaveAttribute("data-collapsed", "")
  await nav.getByRole("button", { name: "Expand sidebar" }).click()
  await expect(nav).not.toHaveAttribute("data-collapsed", "")

  await nav.getByRole("link", { name: "Agents" }).click()
  await expect(nav).not.toHaveAttribute("data-collapsed", "")
})

test("the sidebar collapses to icons and remembers it", async ({ page }) => {
  await page.goto("/operator")
  const nav = page.getByRole("navigation", { name: "Operator" })
  await nav.getByRole("button", { name: "Collapse sidebar" }).click()
  await expect(nav).toHaveAttribute("data-collapsed", "")

  await page.reload()
  await expect(page.getByRole("navigation", { name: "Operator" })).toHaveAttribute("data-collapsed", "")
  await page.getByRole("button", { name: "Expand sidebar" }).click()
  await expect(page.getByRole("navigation", { name: "Operator" })).not.toHaveAttribute("data-collapsed", "")
})

test("Settings → Adapters lists Claude Code and turns it off", async ({ page }) => {
  const patches: unknown[] = []
  await page.route("**/merge/adapter*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify([claude]) }),
  )
  await page.route("**/global/config*", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    patches.push(route.request().postDataJSON())
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({}) })
  })

  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const dialog = page.locator(".settings-v2-dialog")
  await dialog.getByRole("tab", { name: "Adapters" }).click()

  const row = dialog.locator('[data-slot="settings-adapter"][data-adapter="claude"]')
  await expect(row).toContainText("Claude Code")
  await expect(row).toContainText("Ready")
  await expect(row).toContainText("Version 2.1.123")
  await expect(row).toContainText("Use /merge claude in a session")

  await row.locator('[data-slot="switch-control"]').click()
  await expect.poll(() => patches).toEqual([{ merge: { adapters: { claude: { enabled: false } } } }])
})

test("an adapter whose program is missing says so", async ({ page }) => {
  await page.route("**/merge/adapter*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { ...claude, available: false, binary: undefined, version: undefined, message: "Claude Code was not found" },
      ]),
    }),
  )
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const dialog = page.locator(".settings-v2-dialog")
  await dialog.getByRole("tab", { name: "Adapters" }).click()

  const row = dialog.locator('[data-slot="settings-adapter"][data-adapter="claude"]')
  await expect(row).toHaveAttribute("data-status", "missing")
  await expect(row).toContainText("Not installed")
  await expect(row).toContainText("Claude Code was not found")
})
