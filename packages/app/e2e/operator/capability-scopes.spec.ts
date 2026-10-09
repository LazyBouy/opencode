import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// Capability scopes (capability_scopes_spec.md §9): every row says where it comes from and its state;
// a record has the scope's actions; New creates at the scope; the namespace view lists its own layer.

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

test("rows show their scope and state; a namespace command is disabled, reverted and overridden here", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/capabilities${dir}&tab=commands`)
  const table = page.locator('[data-component="operator-table"]')
  const deploy = table.getByRole("row", { name: /deploy/ })
  await expect(deploy).toContainText("Namespace")
  await expect(deploy).toContainText("Inherited")
  await expect(table.getByRole("row", { name: /review/ })).toContainText("Built in")

  await deploy.click()
  const overlay = page.getByRole("dialog")
  await overlay.getByRole("button", { name: "Disable in this project" }).click()
  await expect
    .poll(() => state.capabilityWrites.at(-1))
    .toMatchObject({
      action: "disable",
      body: { kind: "command", name: "deploy" },
      directory,
    })
  await expect(overlay.getByTestId("capability-state")).toHaveText("Turned off in this project")
  await overlay.getByRole("button", { name: "Revert" }).click()
  await expect(overlay.getByTestId("capability-state")).toHaveText("Inherited")
  await overlay.getByRole("button", { name: "Override in this project" }).click()
  await expect(overlay.getByTestId("capability-state")).toHaveText("Overrides the namespace's")
  expect(state.capabilityWrites.map((write) => write.action)).toEqual(["disable", "revert", "override"])
})

test("New command creates it in the project, or in the namespace from the namespace view", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/capabilities${dir}&tab=commands`)
  await page.getByRole("button", { name: "New command" }).click()
  const dialog = page.getByRole("dialog").last()
  await dialog.getByLabel("Name", { exact: true }).fill("ship")
  await dialog.getByLabel("Template", { exact: true }).fill("Ship $ARGUMENTS")
  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await expect
    .poll(() => state.capabilityWrites.at(-1))
    .toMatchObject({
      action: "create",
      body: { kind: "command", name: "ship", text: "Ship $ARGUMENTS" },
    })
  expect(state.capabilityWrites.at(-1)!.body.namespace).toBeUndefined()

  // The namespace view: its own layer, with a note; New creates there.
  await page.getByRole("group", { name: "Scope" }).getByRole("button", { name: "Namespace", exact: true }).click()
  await expect(page.getByTestId("capability-scope-note")).toContainText("OpenCode's own capabilities")
  await expect(page.locator('[data-component="operator-table"]').getByRole("row", { name: /ship/ })).toHaveCount(0)
  await page.getByRole("button", { name: "New command" }).click()
  const second = page.getByRole("dialog").last()
  await second.getByLabel("Name", { exact: true }).fill("audit")
  await second.getByRole("button", { name: "Create", exact: true }).click()
  await expect
    .poll(() => state.capabilityWrites.at(-1))
    .toMatchObject({
      action: "create",
      body: { kind: "command", name: "audit", namespace: "opencode" },
    })
})

test("agents and plugins have their own lists", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/capabilities${dir}`)
  await page.getByRole("tab", { name: /Agents/ }).click()
  await expect(page.locator('[data-component="operator-table"]').getByRole("row", { name: /build/ })).toContainText(
    "Built in",
  )
  await page.getByRole("tab", { name: /Plugins/ }).click()
  await expect(
    page.locator('[data-component="operator-table"]').getByRole("row", { name: /opencode-wakatime/ }),
  ).toContainText("Global")
})

test("in the namespace view, its own command is edited and copied to another namespace", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.namespaces.push({ id: "acme", name: "Acme", purpose: "", createdAt: 1, updatedAt: 1 })
  state.prompt.items.acme = { types: [], layers: [], groups: [], profiles: [] }
  // The namespace view's own item.
  const deploy = state.capabilities.find((item) => item.name === "deploy")!
  deploy.state = "local"
  await page.goto(`/operator/capabilities${dir}&tab=commands&cscope=namespace&ns=opencode`)
  await page
    .locator('[data-component="operator-table"]')
    .getByRole("row", { name: /deploy/ })
    .click()
  const overlay = page.getByRole("dialog")
  await overlay.getByRole("button", { name: "Edit", exact: true }).click()
  const editor = page.getByRole("dialog").last()
  await expect(editor.getByRole("textbox", { name: "Its definition" })).toHaveValue(
    "---\ndescription: Ship it\n---\nDeploy $ARGUMENTS\n",
  )
  await editor.getByRole("textbox", { name: "Its definition" }).fill("Deploy now")
  await editor.getByRole("button", { name: "Save", exact: true }).click()
  await expect
    .poll(() => state.capabilityWrites.at(-1))
    .toMatchObject({
      action: "edit",
      body: { kind: "command", name: "deploy", namespace: "opencode", text: "Deploy now" },
    })

  await overlay.getByRole("button", { name: "Copy to another namespace" }).click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^Acme$/ })
    .click()
  await expect
    .poll(() => state.capabilityWrites.at(-1))
    .toMatchObject({
      action: "copy",
      body: { kind: "command", name: "deploy", namespace: "opencode", to: "acme" },
    })
})
