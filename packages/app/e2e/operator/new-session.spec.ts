import { expect, type Page, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { directory, mockOperator, workspace } from "./mock-operator"

// The New session page (session_fixes_spec.md §2): the i-Phi wordmark where OpenCode's was, and a
// Namespace and a Project dropdown instead of "New project" and the folder-based selector.

const draftID = "draft_operator_new_session"
const server = fixture.serverKey

const open = async (page: Page, scheme: "light" | "dark" = "light") => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  const state = await mockOperator(page)
  await page.addInitScript(
    ({ directory, draftID, server, scheme }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("opencode-color-scheme", scheme)
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server, scheme },
  )
  return state
}

const select = async (page: Page, label: string, option: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${option}$`) })
    .click()
}

test("the i-Phi wordmark fills the wordmark's box, and the dropdowns replace New project", async ({ page }) => {
  await open(page)
  await page.goto(`/new-session?draftId=${draftID}`)
  const mark = page.getByRole("img", { name: "i-Phi" })
  await expect(mark).toBeVisible()
  await expect(mark).toContainText("i-Phi")
  await expect(page.locator('svg[viewBox="0 0 720 129"]')).toHaveCount(0)
  await expect(page.getByRole("button", { name: /New project/ })).toHaveCount(0)
  // The box OpenCode's wordmark fills: the content width, 720 : 129.
  const box = (await mark.boundingBox())!
  const composer = (await page.locator('form[data-component="prompt-input-v2"]').boundingBox())!
  expect(Math.abs(box.width - composer.width)).toBeLessThan(2)
  expect(Math.abs(box.height - (box.width * 129) / 720)).toBeLessThan(2)
  // Namespace OpenCode and its default project.
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Namespace"]')).toContainText("OpenCode")
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Project"]')).toContainText("smoke-project")
})

for (const scheme of ["light", "dark"] as const) {
  test(`in ${scheme} mode the symbol and text take the theme colour and the dot stays orange`, async ({ page }) => {
    await open(page, scheme)
    await page.goto(`/new-session?draftId=${draftID}`)
    const mark = page.getByRole("img", { name: "i-Phi" })
    await expect(mark).toBeVisible()
    const colors = await mark.evaluate((element) => ({
      text: getComputedStyle(element.querySelector('[data-slot="operator-iphi-text"]')!).color,
      shape: getComputedStyle(element.querySelector("svg path")!).fill,
      dot: getComputedStyle(element.querySelector("svg circle")!).fill,
    }))
    expect(colors.shape).toBe(colors.text)
    expect(colors.dot).toBe("rgb(248, 124, 66)")
  })
}

test("another namespace takes its default project; one without projects blocks sending", async ({ page }) => {
  const state = await open(page)
  state.prompt.namespaces.push(
    { id: "acme", name: "Acme", purpose: "", folder: `${workspace}/apps`, createdAt: 1, updatedAt: 1 },
    { id: "empty", name: "Empty", purpose: "", folder: `${workspace}/empty`, createdAt: 1, updatedAt: 1 },
  )
  for (const ns of ["acme", "empty"]) state.prompt.items[ns] = { types: [], layers: [], groups: [], profiles: [] }
  state.prompt.projects[`${workspace}/site`] = { namespace: "acme" }
  const created: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/session") created.push(request.url())
  })
  await page.goto(`/new-session?draftId=${draftID}`)
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Project"]')).toContainText("smoke-project")

  await select(page, "Namespace", "Acme")
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Project"]')).toContainText("site")
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("opencode.window.browser.dat:tabs") ?? ""))
    .toContain(`${workspace}/site`)

  await select(page, "Namespace", "Empty")
  await expect(page.getByText("No projects in this namespace")).toBeVisible()
  await expect(page.getByRole("button", { name: "Add a project on the Projects page" })).toBeVisible()
  await page.locator('form[data-component="prompt-input-v2"] [contenteditable="true"]').fill("Hello")
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "Send" }).click()
  await page.waitForTimeout(500)
  expect(created).toEqual([])
  await page.getByRole("button", { name: "Add a project on the Projects page" }).click()
  await expect(page).toHaveURL(/\/operator\/projects\?ns=empty/)
})

test("a tab opened outside any project starts in OpenCode with its default project", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: [],
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  const state = await mockOperator(page)
  state.prompt.namespaces[0]!.defaultProject = directory
  await page.addInitScript(
    ({ draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory: "/tmp/elsewhere" }]),
      )
    },
    { draftID, server },
  )
  await page.goto(`/new-session?draftId=${draftID}`)
  await expect(page.locator('[data-component="select-v2-root"][aria-label="Namespace"]')).toContainText("OpenCode")
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("opencode.window.browser.dat:tabs") ?? ""))
    .toContain(directory)
})

test("an agent that is not one of the project's members is told so, and cannot send", async ({ page }) => {
  const state = await open(page)
  state.projectRecords[directory] = { description: "", status: "active", members: ["reviewer"], groups: [] }
  await page.goto(`/new-session?draftId=${draftID}`)
  await expect(page.getByText(/is not a member of smoke-project/)).toBeVisible()
})
