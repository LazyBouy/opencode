import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

const dir = `?dir=${encodeURIComponent(directory)}`

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

test("the dashboard shows usage, approvals and recent sessions", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator")

  const tiles = page.locator('[data-slot="operator-tiles"]')
  await expect(tiles).toContainText("1.18.34-fork")
  await expect(tiles).toContainText("$3.25")
  await expect(tiles.locator('[data-component="operator-stat"][data-tone="warn"]')).toContainText("1")
  await expect(tiles.locator('[data-component="operator-sparkline"]').first()).toBeVisible()

  const recent = page.locator('[data-component="operator-panel"]').filter({ hasText: "Recent sessions" })
  await expect(recent).toContainText("Fix the parser")
  await recent.getByRole("row", { name: /Fix the parser/ }).click()
  await expect(page).toHaveURL(/\/session\/ses_op_1$/)
})

test("the agents table filters, hides hidden agents and opens an agent", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents${dir}`)

  const table = page.locator('[data-component="operator-table"]')
  await expect(table).toContainText("build")
  await expect(table).toContainText("reviewer")
  await expect(table).not.toContainText("title")
  await page.getByRole("switch", { name: "Show hidden agents" }).locator("..").locator('[data-slot="switch-control"]').click()
  await expect(table).toContainText("title")

  await page.getByRole("searchbox", { name: "Search agents" }).fill("review")
  await expect(table.locator("tbody tr")).toHaveCount(1)
  await table.getByRole("row", { name: /reviewer/ }).click()

  await expect(page).toHaveURL(/\/operator\/agents\/reviewer\?dir=/)
  await expect(page.getByRole("heading", { level: 1, name: "reviewer" })).toBeVisible()
  await page.getByRole("tab", { name: "Prompt" }).click()
  await expect(page.locator('[data-component="operator-code"]')).toContainText("Review the diff carefully.")
})

test("an agent's permission rules are listed in order", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}`)
  await page.getByRole("tab", { name: "Permissions" }).click()
  const rows = page.locator('[data-component="operator-table"] tbody tr')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(1)).toContainText("rm *")
  await expect(rows.nth(1)).toContainText("Ask")
})

test("the sessions page searches on the server and opens a session", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/sessions")
  const table = page.locator('[data-component="operator-table"]')
  await expect(table.locator("tbody tr")).toHaveCount(2)

  const search = page.getByRole("searchbox", { name: "Search titles" })
  await search.fill("plan")
  await search.press("Enter")
  await expect(table.locator("tbody tr")).toHaveCount(1)
  expect(state.sessionQueries.some((query) => query.get("search") === "plan" && query.get("roots") === "true")).toBe(
    true,
  )
  await table.getByRole("row", { name: /Plan the release/ }).click()
  await expect(page).toHaveURL(/\/session\/ses_op_2$/)
})

test("the inbox answers a pending request in its project", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/inbox")
  const ask = page.locator('[data-component="operator-ask"][data-request="per_op_1"]')
  await expect(ask).toContainText("git push origin main")
  await expect(page.locator('[data-component="operator-ask-group"]')).toContainText("Fix the parser")

  await ask.getByRole("button", { name: "Allow once" }).click()
  await expect.poll(() => state.replies.length).toBe(1)
  expect(new URL(state.replies[0].url).searchParams.get("directory")).toBe(directory)
  expect(state.replies[0].body).toEqual({ reply: "once" })
  await expect(page.getByText("Nothing is waiting for approval")).toBeVisible()
})

test("the config page saves the project file and shows validation errors", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/config${dir}`)
  await expect(page.locator('[data-component="operator-sources"]')).toContainText(".opencode/opencode.jsonc")

  const editor = page.getByRole("textbox", { name: "Edit settings" })
  await expect(editor).toHaveValue('{\n  "username": "me"\n}\n')
  state.rejectWrite = "share: Expected manual, auto or disabled"
  await editor.fill('{ "share": "sometimes" }')
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page.locator('[data-slot="operator-error"]')).toContainText("share: Expected")
  const write = state.writes[0]
  expect(new URL(write.url).searchParams.get("scope")).toBe("project")
  expect(write.body).toEqual({ text: '{ "share": "sometimes" }' })
})

test("capabilities list tools by origin and connect an MCP server", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/capabilities${dir}`)
  const tools = page.locator('[data-component="operator-table"]').first()
  await expect(tools.getByRole("row", { name: /docs_search/ })).toContainText("MCP")
  await expect(tools.getByRole("row", { name: /hello/ })).toContainText("Custom")

  await page.getByRole("tab", { name: /Skills/ }).click()
  await expect(page.getByRole("cell", { name: "release-notes", exact: true })).toBeVisible()
  await page.getByRole("tab", { name: /MCP servers/ }).click()
  await page.getByRole("row", { name: /docs/ }).getByRole("button", { name: "Connect" }).click()
  await expect.poll(() => state.connects).toEqual(["/mcp/docs/connect"])
})

test("the models page lists the catalog with limits and prices", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/models${dir}`)
  const row = page.getByRole("row", { name: /Claude Opus 4.6/ })
  await expect(row).toContainText("200K")
  await expect(row).toContainText("$15.00")
  await expect(row).toContainText("Default")
})
