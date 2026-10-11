import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// Onboarding (memory_spec.md §10): a new installation opens the welcome page from any page; its steps are the
// working folder, the default project, the merged agents and a summary; then the console opens.

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

test("a new installation is onboarded: folder, project, merged agents, summary, then the console", async ({ page }) => {
  const state = await mockOperator(page)
  state.onboarding.status = {
    ...state.onboarding.status,
    pending: true,
    agents: [{ id: "claude", name: "Claude Code", folder: "/claude-config/projects", exists: true, insideHome: false }],
  }
  await page.goto("/operator/projects")
  await expect(page).toHaveURL(/\/operator\/welcome$/)
  const steps = page.getByTestId("welcome-steps")
  await expect(steps.getByLabel("Working folder", { exact: true })).toHaveValue("/root/opencode-home")
  await expect(steps.getByTestId("welcome-opencode-folder")).toContainText("/root/opencode-home/opencode")

  await steps.getByRole("button", { name: "Next" }).click()
  await expect(steps.getByLabel("Project folder name", { exact: true })).toHaveValue("opencode")
  await expect(steps.getByTestId("welcome-project-folder")).toContainText("/root/opencode-home/opencode/opencode")
  await expect(steps).toContainText("The OpenCode source code isn't added as a project")

  await steps.getByRole("button", { name: "Next" }).click()
  const claude = steps.getByTestId("welcome-agent-claude")
  await expect(claude).toContainText("outside your home folder (/root)")
  await expect(claude).toContainText("start anew instead of resuming")
  await expect(claude).toContainText("moves across file systems are skipped")

  await steps.getByRole("button", { name: "Next" }).click()
  const summary = steps.getByTestId("welcome-summary")
  await expect(summary).toContainText("/root/opencode-home/opencode/opencode")
  await expect(summary).toContainText("(a new git repository)")
  await expect(summary.getByTestId("welcome-warnings")).toContainText("1: see Merged agents")
  expect(state.onboarding.writes.filter((write) => write.action === "finish")).toEqual([])

  await steps.getByRole("button", { name: "Set up" }).click()
  await expect.poll(() => state.onboarding.writes.filter((write) => write.action === "finish").length).toBe(1)
  expect(state.onboarding.writes.find((write) => write.action === "finish")!.body).toEqual({
    workingDir: "/root/opencode-home",
    project: "opencode",
    git: true,
  })
  await expect(page).toHaveURL(/\/operator$/)
})

test("a problem with the folder keeps the step", async ({ page }) => {
  const state = await mockOperator(page)
  state.onboarding.status = { ...state.onboarding.status, pending: true }
  state.onboarding.problems = ["/root/projects/app is inside a git repository"]
  await page.goto("/operator/welcome")
  const steps = page.getByTestId("welcome-steps")
  await steps.getByLabel("Working folder", { exact: true }).fill("/root/projects/app")
  await steps.getByRole("button", { name: "Next" }).click()
  await expect(steps.getByTestId("welcome-problems")).toContainText("inside a git repository")
  await expect(steps.getByLabel("Working folder", { exact: true })).toBeVisible()
  expect(state.onboarding.writes.at(-1)!.body).toMatchObject({ workingDir: "/root/projects/app" })
})

test("an installation that isn't waiting stays where it is", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/projects")
  await expect(page.getByTestId("welcome")).toHaveCount(0)
  await expect(page).toHaveURL(/\/operator\/projects/)
  await page.goto("/operator/welcome")
  await expect(page.getByTestId("welcome-not-waiting")).toContainText("set up before onboarding came")
})
