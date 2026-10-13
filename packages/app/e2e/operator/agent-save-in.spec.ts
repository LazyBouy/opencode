import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { idFor } from "./mock-namespaces"
import { directory, mockOperator } from "./mock-operator"

// Where an agent is saved (agent_form_spec.md §1, §7; capability_scopes_spec.md §11): its namespace, then its
// default project, another project of it, or the whole namespace; on edit, where it is defined, and Move.

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
const other = "/home/me/other"
const select = (page: Page, label: string) =>
  page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`)
const choose = async (page: Page, label: string, option: string | RegExp) => {
  await select(page, label).click()
  await page.locator('[data-component="menu-v2-item"]').filter({ hasText: option }).last().click()
}

test("a new agent is saved in its namespace's default project, another project of it, or the whole namespace", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.prompt.projects[other] = { namespace: "opencode", id: idFor(other) }
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("docs")
  await expect(select(page, "Namespace")).toContainText("OpenCode · opencode")
  await expect(select(page, "Save in")).toContainText(`The default project (smoke-project · ${idFor(directory)})`)

  // Another project: only the namespace's projects, and one must be chosen.
  await choose(page, "Save in", "Another project")
  await page.getByRole("button", { name: "Create agent" }).click()
  await expect(page.locator('[data-slot="operator-error"]')).toHaveText("Choose the project to save the agent in.")
  await choose(page, "Choose a project", /^other · /)

  // The whole namespace: its folder's .opencode, and no Small model.
  await choose(page, "Save in", "This namespace (every project in it)")
  await expect(page.getByTestId("agent-target")).toHaveText(/^Saved to .*\/\.opencode\/agents\/docs\.md$/)
  await expect(page.getByRole("button", { name: "Small model", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Create agent" }).click()
  await expect.poll(() => state.agentWrites.length).toBe(1)
  const written = new URL(state.agentWrites[0]!.url)
  expect(written.searchParams.get("scope")).toBe("namespace")
  expect(written.searchParams.get("directory")).toBe(directory)
})

test("choosing another namespace asks first when Save in or the home folder was set", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("docs")
  await page.getByLabel("Home folder", { exact: true }).fill("work/docs")
  await choose(page, "Namespace", "Global · global")
  const question = page.getByRole("dialog").filter({ hasText: "Change the namespace?" })
  await question.getByRole("button", { name: "Cancel" }).click()
  await expect(select(page, "Namespace")).toContainText("OpenCode · opencode")
  await choose(page, "Namespace", "Global · global")
  await page.getByRole("dialog").getByRole("button", { name: "Change namespace" }).click()
  await expect(page.getByTestId("agent-save-in-global")).toBeVisible()
  // The home folder went back to the agent's own.
  await expect(page.getByLabel("Home folder", { exact: true })).toHaveValue("agents/docs")
})

test("editing an agent says where it is saved, and it can move to another project", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.projects[other] = { namespace: "opencode", id: idFor(other) }
  await page.goto(`/operator/agents/reviewer/edit${dir}`)
  const saved = page.getByTestId("agent-saved-in")
  await expect(saved).toContainText(`This project (smoke-project · ${idFor(directory)})`)
  await saved.getByRole("button", { name: "Move to another project" }).click()
  await choose(page, "Project to move it to", /^other · /)
  await page.getByTestId("agent-move").getByRole("button", { name: "Move", exact: true }).click()
  await expect.poll(() => state.agentWrites.length).toBe(1)
  expect(new URL(state.agentWrites[0]!.url).pathname).toBe("/operator/agent/reviewer/move")
  expect(state.agentWrites[0]!.body).toEqual({ project: other })
  await expect(page).toHaveURL(new RegExp(`dir=${encodeURIComponent(other)}`))

  // A built-in agent is part of every project: no Move.
  await page.goto(`/operator/agents/build/edit${dir}`)
  await expect(page.getByTestId("agent-saved-in")).toContainText("Built into OpenCode")
  await expect(page.getByRole("button", { name: "Move to another project" })).toHaveCount(0)
})
