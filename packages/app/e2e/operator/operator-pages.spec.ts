import { expect, type Page, test } from "@playwright/test"
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
  // A recent session opens in the overlay; Open in Chats opens the full session page.
  await recent.getByRole("row", { name: /Fix the parser/ }).click()
  await expect(page).toHaveURL(/session=ses_op_1/)
  await page.getByRole("dialog").getByRole("button", { name: "Open in Chats" }).click()
  await expect(page).toHaveURL(/\/session\/ses_op_1$/)
})

test("the agents table filters, hides hidden agents and opens an agent", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents${dir}`)

  const table = page.locator('[data-component="operator-table"]')
  await expect(table).toContainText("build")
  await expect(table).toContainText("reviewer")
  await expect(table).not.toContainText("title")
  await page
    .getByRole("switch", { name: "Show hidden agents (2)" })
    .locator("..")
    .locator('[data-slot="switch-control"]')
    .click()
  await expect(table).toContainText("title")

  await page.getByRole("searchbox", { name: "Search agents" }).fill("review")
  await expect(table.locator("tbody tr")).toHaveCount(1)
  await table.getByRole("row", { name: /reviewer/ }).click()

  // The agent opens in the overlay, its sections on the left.
  await expect(page).toHaveURL(/agent=reviewer/)
  const overlay = page.getByRole("dialog")
  await expect(overlay.getByRole("heading", { name: /reviewer/ })).toBeVisible()
  await overlay.getByRole("tab", { name: "Sys Prompt" }).click()
  await expect(page).toHaveURL(/atab=prompt/)
  await expect(
    overlay.locator('[data-slot="operator-prompt-section"]').filter({ hasText: "Agent prompt" }),
  ).toContainText("Review the diff carefully.")
})

test("Agents lists every project's agents with their project, and New agent asks which project", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/agents")
  const table = page.locator('[data-component="operator-table"]')
  await expect(table).toContainText("reviewer")
  await expect(table.getByRole("columnheader", { name: "Project" })).toBeVisible()
  await expect(table.getByRole("row", { name: /reviewer/ })).toContainText("smoke-project")
  await expect(page.locator('[data-component="select-v2"]').first()).toContainText("All projects")
  await page.getByRole("button", { name: "New agent" }).click()
  await page.getByRole("menuitem", { name: "smoke-project" }).click()
  await expect(page).toHaveURL(/\/operator\/agents\/new\?dir=/)
})

test("text can be selected and copied on every page and in overlays; controls stay unselectable", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=prompt`)
  const userSelect = (locator: ReturnType<Page["locator"]>) =>
    locator.evaluate((element) => getComputedStyle(element).userSelect)

  // A section of the prompt, in the agent's overlay: a triple click selects its text.
  const text = page.locator('[data-slot="operator-prompt-section"] [data-component="operator-code"]').first()
  await expect(text).toContainText("You are opencode")
  await text.click({ clickCount: 3 })
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("You are opencode")
  expect(await userSelect(page.getByTestId("prompt-trace").first())).toBe("text")
  // The page behind it, and the controls.
  expect(await userSelect(page.locator('[data-slot="operator-page-description"], header p').first())).toBe("text")
  expect(await userSelect(page.getByRole("button", { name: "Close" }).first())).toBe("none")
  expect(await userSelect(page.getByRole("tab", { name: "Sys Prompt" }))).toBe("none")
})

test("the project chosen on one page stays chosen on every page until it is changed", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/agents")
  const picker = page.locator('[data-component="select-v2-root"][aria-label="Project"]')
  await expect(picker).toContainText("All projects")
  await picker.locator('[data-component="select-v2"]').click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^smoke-project/ })
    .click()
  await expect(picker).toContainText("smoke-project")

  // The sidebar's links carry no project; the choice stands anyway, on every page.
  await page.getByRole("link", { name: "Dashboard", exact: true }).click()
  await page.getByRole("link", { name: "Agents", exact: true }).click()
  await expect(page).toHaveURL(/\/operator\/agents/)
  await expect(picker).toContainText("smoke-project")
  await page.getByRole("link", { name: "Sessions", exact: true }).click()
  await expect(picker).toContainText("smoke-project")
  // And after a reload.
  await page.goto("/operator/agents")
  await expect(picker).toContainText("smoke-project")

  // All projects is a choice too.
  await picker.locator('[data-component="select-v2"]').click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^All projects/ })
    .click()
  await page.getByRole("link", { name: "Sessions", exact: true }).click()
  await expect(picker).toContainText("All projects")
})

test("per-project pages use a project the server knows when none is open in the browser", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/config")
  await expect(page.locator('[data-component="select-v2"]').first()).toContainText("smoke-project")
})

test("the projects page lists projects and opens a project's agents", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/projects")
  const rows = page.locator('[data-component="operator-table"] tbody tr')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText("smoke-project")
  await expect(rows.nth(1)).toContainText("notes")
  await rows.nth(0).click()
  // The project's Agents section lists its agents; one opens in the Agents page's overlay.
  await page.getByRole("dialog").getByRole("tab", { name: "Agents", exact: true }).click()
  await expect(page.getByRole("dialog").getByTestId("project-agent").filter({ hasText: "reviewer" })).toBeVisible()
  await page.getByRole("dialog").getByTestId("project-agent").filter({ hasText: "reviewer" }).click()
  await expect(page).toHaveURL(/\/operator\/agents\?.*agent=reviewer/)
  await expect(page.locator('[data-component="operator-table"]')).toContainText("reviewer")
})

test("an agent's permission lines in force are listed, each with its level and where it comes from", async ({
  page,
}) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}`)
  const overlay = page.getByRole("dialog")
  await overlay.getByRole("tab", { name: "Permissions" }).click()
  const rows = overlay.locator('[data-component="operator-table"] tbody tr')
  await expect(rows).toHaveCount(5)
  await expect(rows.nth(2)).toContainText("*.env")
  await expect(rows.nth(2)).toContainText("Ask")
  await expect(rows.nth(2)).toContainText("OpenCode default")
  await expect(rows.nth(3)).toContainText("OpenCode truncation folder")
  await expect(rows.nth(4)).toContainText("Project · Config permission")
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
  // A session opens in the overlay: its conversation, with a prompt box; Open in Chats opens the full page.
  await table.getByRole("row", { name: /Plan the release/ }).click()
  await expect(page).toHaveURL(/session=ses_op_2/)
  const overlay = page.getByRole("dialog")
  for (const section of ["Conversation", "Details", "Subagents"])
    await expect(overlay.getByRole("tab", { name: section })).toBeVisible()
  const sent: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/prompt_async")) sent.push(request.postData() ?? "")
  })
  await overlay.getByLabel("Message", { exact: true }).fill("Keep going.")
  await overlay.getByRole("button", { name: "Send" }).click()
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toContain("Keep going.")
  await overlay.getByRole("button", { name: "Open in Chats" }).click()
  await expect(page).toHaveURL(/\/session\/ses_op_2$/)
})

test("the inbox answers a pending request in its project", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/inbox")
  const ask = page.locator('[data-component="operator-ask"][data-request="per_op_1"]')
  await expect(ask).toContainText("git push origin main")
  await expect(page.locator('[data-component="operator-ask-group"]')).toContainText("Fix the parser")

  // It opens its reply card: Allow answers this request only.
  await ask.click()
  await page.getByRole("dialog").getByTestId("reply-card").getByRole("button", { name: "Allow", exact: true }).click()
  await expect.poll(() => state.decides.length).toBe(1)
  expect(state.decides[0]).toEqual({ id: "per_op_1", body: { decision: "allow", via: "inbox" } })
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

test("the config page edits the namespace's config too, and says where each setting comes from", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/config${dir}`)
  await expect(page.locator('[data-component="operator-sources"]')).toContainText("Namespace")
  await expect(page.getByTestId("config-origins")).toContainText("model")
  await expect(page.getByTestId("config-origins")).toContainText("Namespace")
  await page.getByRole("button", { name: "Namespace", exact: true }).click()
  const editor = page.getByRole("textbox", { name: "Edit settings" })
  await expect(editor).toHaveValue('{ "model": "opencode/big" }')
  await editor.fill('{ "model": "opencode/small" }')
  await page.getByRole("button", { name: "Save" }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(new URL(state.writes[0]!.url).searchParams.get("scope")).toBe("namespace")
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
})

test("Providers & Models: a namespace picker, the models of its default project, and Use as writes the global config", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/models${dir}`)
  // The namespace picker replaces the project picker; the single default/small panel is gone.
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Project"]')).toHaveCount(0)
  await expect(page.getByTestId("model-defaults")).toHaveCount(0)
  await expect(page.getByTestId("models-listed-from")).toContainText("the namespace's default project")
  await page.getByRole("row", { name: /Claude Opus 4.6/ }).click()
  const overlay = page.getByRole("dialog")
  await expect(overlay.locator('[data-component="operator-scope-switch"]')).toHaveCount(0)
  await overlay.getByRole("button", { name: "Use as small model (global)" }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(new URL(state.writes[0]!.url).searchParams.get("scope")).toBe("global")
  expect(state.writes[0]!.body).toEqual({ small_model: "opencode/claude-opus-4-6" })
})

test("capabilities and inbox requests open in the overlay, with ‹ › through the list", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/capabilities${dir}`)
  await page.locator('[data-component="operator-table"]').getByRole("row", { name: /read/ }).first().click()
  const overlay = page.getByRole("dialog")
  await expect(
    overlay.getByRole("tablist", { name: "Capabilities" }).getByRole("tab", { name: "Skills" }),
  ).toBeVisible()
  await expect(overlay.getByRole("button", { name: "Next record" })).toBeVisible()
  await overlay.getByRole("button", { name: "Close" }).click()

  await page.goto("/operator/inbox")
  await page.locator('[data-component="operator-ask"]').first().locator('[data-slot="operator-ask-patterns"]').click()
  await expect(page).toHaveURL(/ask=/)
  await overlay.getByRole("button", { name: "Allow", exact: true }).click()
  // The last request answered: the overlay closes.
  await expect(overlay).toBeHidden()
  expect(state.pending).toHaveLength(0)
})
