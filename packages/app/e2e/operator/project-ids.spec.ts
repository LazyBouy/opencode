import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { idFor } from "./mock-namespaces"
import { mockOperator } from "./mock-operator"

// specs/docs/issues/002: every project picker offers the Projects page's projects; same-named projects in two
// namespaces are told apart by their ids; a link to a folder that isn't a project says so.

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

const opencodeApp = "/workspace/opencode/app"
const acmeApp = "/workspace/acme/app"

for (const where of ["agents", "sessions"]) {
  test(`the ${where} page's picker tells two "app" projects apart by their ids, and shows the chosen one's`, async ({
    page,
  }) => {
    const state = await mockOperator(page)
    state.prompt.namespaces.push({ id: "acme", name: "Acme", purpose: "", createdAt: 0, updatedAt: 0 })
    state.prompt.items.acme = { types: [], layers: [], groups: [], profiles: [] }
    state.prompt.projects[opencodeApp] = { namespace: "opencode", id: idFor(opencodeApp) }
    state.prompt.projects[acmeApp] = { namespace: "acme", id: idFor(acmeApp) }
    await page.goto(`/operator/${where}?dir=${encodeURIComponent(opencodeApp)}`)

    await expect(page.getByTestId("scope-project-id")).toContainText(idFor(opencodeApp))
    await expect(page.getByTestId("scope-namespace-id")).toContainText("opencode")
    await page.locator('[data-component="select-v2-root"][aria-label="Project"] [data-component="select-v2"]').click()
    const options = page.locator('[data-component="menu-v2-item"]')
    await expect(options.filter({ hasText: `app · ${idFor(opencodeApp)}` })).toHaveCount(1)
    await expect(options.filter({ hasText: `app · ${idFor(acmeApp)}` })).toHaveCount(1)
    await options.filter({ hasText: `app · ${idFor(acmeApp)}` }).click()

    await expect(page).toHaveURL(new RegExp(`dir=${encodeURIComponent(acmeApp)}`))
    await expect(page.getByTestId("scope-project-id")).toContainText(idFor(acmeApp))
    await expect(page.getByTestId("scope-namespace-id")).toContainText("acme")
    await expect(page.getByTestId("scope-project-id")).toHaveAttribute("title", acmeApp)
  })
}

test("a link to a folder that isn't a project says so, and offers to make it one", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents?dir=${encodeURIComponent("/somewhere/else")}`)
  const note = page.getByTestId("scope-not-project")
  await expect(note).toContainText("This folder isn't a project:")
  await expect(note.getByRole("button", { name: "Make this folder a project" })).toBeVisible()
})
