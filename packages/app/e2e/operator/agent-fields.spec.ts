import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// The agent form's checked fields (agent_form_spec.md §3–§5): Temperature, Top P and Step limit as typed, the
// colour (a theme colour by name, or a custom #RRGGBB), and the home folder inside the project.

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
const choose = async (page: Page, label: string, option: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

test("Temperature, Top P and Step limit are checked as typed; an error blocks Save, the Anthropic limit only warns", async ({
  page,
}) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("docs")
  const create = page.getByRole("button", { name: "Create agent" })

  await page.getByLabel("Temperature", { exact: true }).fill("2.5")
  await expect(page.getByTestId("check-temperature")).toHaveText("Temperature is from 0 to 2.")
  await expect(create).toBeDisabled()
  // The default model here is a Claude model: above 1 warns.
  await page.getByLabel("Temperature", { exact: true }).fill("1.5")
  await expect(page.getByTestId("check-temperature")).toHaveText(
    "Anthropic models take 0 to 1: a higher value may be refused.",
  )
  await expect(create).toBeEnabled()
  await page.getByLabel("Temperature", { exact: true }).fill("")

  await page.getByLabel("Top P", { exact: true }).fill("0")
  await expect(page.getByTestId("check-top-p")).toHaveText("Top P is above 0 and up to 1.")
  await expect(create).toBeDisabled()
  await page.getByLabel("Top P", { exact: true }).fill("0.9")
  await page.getByLabel("Step limit", { exact: true }).fill("0")
  await expect(page.getByTestId("check-steps")).toHaveText("The step limit is a whole number, 1 or more.")
  await expect(create).toBeDisabled()
  await page.getByLabel("Step limit", { exact: true }).fill("12")
  await expect(create).toBeEnabled()
})

test("a theme colour is stored by its name; a custom colour as #RRGGBB, kept in step with R, G and B", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("docs")
  await choose(page, "Color", "Warning")
  await expect(page.getByTestId("color-chosen")).toContainText("Warning")

  await choose(page, "Color", "Custom colour…")
  const picker = page.getByTestId("color-picker")
  await picker.getByRole("textbox", { name: "Hex" }).fill("#336699")
  await expect(picker.getByRole("textbox", { name: "Red (0–255)" })).toHaveValue("51")
  await expect(picker.getByRole("textbox", { name: "Green (0–255)" })).toHaveValue("102")
  await picker.getByRole("textbox", { name: "Blue (0–255)" }).fill("255")
  await expect(page.getByTestId("color-chosen")).toContainText("#3366FF")
  await page.getByRole("button", { name: "Create agent" }).click()
  await expect.poll(() => state.agentWrites.length).toBe(1)
  expect(state.agentWrites[0]!.body).toMatchObject({ color: "#3366FF" })
})

test("the home folder stays inside the project: .. and folders elsewhere are refused", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("docs")
  const home = page.getByLabel("Home folder", { exact: true })
  await expect(page.getByTestId("agent-home")).toContainText(`${directory}/`)
  await home.fill("../outside")
  await expect(page.getByTestId("check-home")).toContainText("can't lead out of the project")
  await expect(page.getByRole("button", { name: "Create agent" })).toBeDisabled()
  await home.fill("/etc")
  await expect(page.getByTestId("check-home")).toContainText("The home folder is inside the project.")
  await page.getByTestId("check-home").getByRole("button", { name: "Move into the project" }).click()
  await expect(home).toHaveValue("agents/docs")
  await expect(page.getByTestId("check-home")).toHaveCount(0)
  // Browse stays inside the project: no git repositories made there.
  await page.getByTestId("agent-home").getByRole("button", { name: "Browse…" }).click()
  const browser = page.getByRole("dialog")
  await expect(browser.getByText("Make it a git project")).toBeHidden()
  await expect(browser.getByRole("button", { name: "Use this folder" })).toBeVisible()
  await browser.getByRole("button", { name: "Cancel" }).click()
})
