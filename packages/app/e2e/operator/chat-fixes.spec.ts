import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// Iteration 5 fixes, phase 1 (fixes_spec.md §5, §7, §9): the views in the order User, Detailed,
// Transcript with Session details always first; Transcript is read-only but a waiting request stays
// answerable; the chat header names the project; a namespace's (i) sits on its name's line.

const sessionHref = (id: string) => `/server/${base64Encode(fixture.serverKey)}/session/${id}`
const permissions: unknown[] = []

test.beforeEach(async ({ page }) => {
  permissions.length = 0
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session, agent: "build" })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    permissions: () => permissions,
  })
  await mockOperator(page)
})

// Session details, then 8 px, then the switch, on one line.
async function expectControls(page: Page) {
  const controls = page.getByTestId("operator-titlebar-controls")
  await expect(controls).toHaveCount(1)
  await expect(controls.locator('[data-action="operator-inspector"]')).toBeVisible()
  const layout = await controls.evaluate((element) => {
    const inspector = element.querySelector('[data-action="operator-inspector"]')!.getBoundingClientRect()
    const views = element.querySelector('[data-testid="session-view-switch"]')!.getBoundingClientRect()
    return {
      gap: views.left - inspector.right,
      offset: Math.abs(inspector.top + inspector.height / 2 - (views.top + views.height / 2)),
    }
  })
  expect(layout.gap).toBeGreaterThanOrEqual(7)
  expect(layout.gap).toBeLessThanOrEqual(9)
  expect(layout.offset).toBeLessThanOrEqual(2)
}

test("the views read User, Detailed, Transcript, with Session details always first", async ({ page }) => {
  await page.goto(sessionHref(fixture.targetID))
  const views = page.getByTestId("session-view-switch")
  await expect(views.getByRole("button")).toHaveText(["User", "Detailed", "Transcript"])
  await expectControls(page)

  // Switching views, opening an operator page and coming back, and switching sessions keep it.
  await views.getByRole("button", { name: "Detailed" }).click()
  await expectControls(page)
  await views.getByRole("button", { name: "Transcript" }).click()
  await expectControls(page)
  await page.getByRole("navigation", { name: "Operator" }).getByRole("link", { name: "Agents" }).click()
  await expect(page.getByTestId("operator-titlebar-controls")).toHaveCount(0)
  await page.goBack()
  await expectControls(page)
  await page.goto(sessionHref(fixture.sourceID))
  await expectControls(page)
})

test("Transcript is read-only: no composer, a bar to switch, and a waiting request stays answerable", async ({
  page,
}) => {
  await page.goto(`${sessionHref(fixture.targetID)}?view=transcript`)
  const bar = page.getByTestId("transcript-readonly")
  await expect(bar).toContainText("Read-only: this view shows exactly what was sent and received.")
  await expect(page.locator('[data-component="prompt-input"]')).toBeHidden()

  // Typing does not reach the composer.
  await page.getByTestId("transcript").click({ position: { x: 5, y: 5 } })
  await page.keyboard.type("hello")
  await bar.getByRole("button", { name: "User" }).click()
  await expect(page).not.toHaveURL(/view=transcript/)
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
  await expect(page.locator('[data-component="prompt-input"]')).not.toContainText("hello")

  // A permission request waiting: its dock shows in Transcript too.
  permissions.push({
    id: "per_waiting",
    sessionID: fixture.targetID,
    permission: "bash",
    patterns: ["git status"],
    metadata: {},
    always: [],
  })
  await page.goto(`${sessionHref(fixture.targetID)}?view=transcript`)
  const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await expect(dock).toBeVisible()
  await expect(dock.getByText("git status")).toBeVisible()
  await expect(page.locator('[data-component="prompt-input"]')).toBeHidden()
})

test("the chat header names the project, with its folder on hover", async ({ page }) => {
  await page.goto(sessionHref(fixture.targetID))
  const project = page.getByTestId("chat-project")
  await expect(project).toHaveText(/^Project: /)
  await expect(project).toHaveAttribute("title", new RegExp(fixture.directory))
})

test("a namespace's (i) sits on its name's line", async ({ page }) => {
  await page.goto("/operator")
  await page.getByRole("navigation", { name: "Operator" }).getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".settings-v2-dialog")
  await settings.getByRole("tab", { name: "Namespaces" }).click()
  const title = settings.locator('[data-slot="settings-v2-row-title"]').first()
  const name = title.locator(":scope > span").first()
  const help = title.locator('[data-component="field-help"]')
  await expect(help).toBeVisible()
  const nameBox = (await name.boundingBox())!
  const helpBox = (await help.boundingBox())!
  expect(helpBox.x).toBeGreaterThan(nameBox.x + nameBox.width - 1)
  expect(Math.abs(helpBox.y + helpBox.height / 2 - (nameBox.y + nameBox.height / 2))).toBeLessThanOrEqual(3)
})
