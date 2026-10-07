import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// Iteration 5 fixes, phase 4 (fixes_spec.md §4.2, §6): locks on an agent's rules, the subagent's lock
// option, the session editor in two blocks, and Session permissions in the chat's "…" menu.

const dir = `?dir=${encodeURIComponent(directory)}`

test("an agent's rules lock one by one, or all at once", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}&tab=permissions`)
  const table = page.getByRole("table", { name: "Permissions" })
  await expect(table.getByRole("columnheader", { name: /Sessions may override/ })).toBeVisible()
  const webfetch = table.getByRole("row", { name: /webfetch/ })
  await expect(webfetch.getByRole("checkbox", { name: "Sessions may override webfetch *" })).toBeChecked()
  await webfetch.locator('[data-slot="checkbox-v2-control"]').click()
  await expect.poll(() => state.lockWrites.length).toBe(1)
  expect(state.lockWrites[0]).toEqual({
    agent: "build",
    body: { locks: [{ permission: "webfetch", pattern: "*" }], inherit: "own" },
  })
  await expect(webfetch.getByRole("checkbox", { name: "Sessions may override webfetch *" })).not.toBeChecked()

  await page.getByRole("button", { name: "Lock all", exact: true }).click()
  await expect.poll(() => state.lockWrites.length).toBe(2)
  expect((state.lockWrites[1]!.body as { locks: unknown[] }).locks).toHaveLength(5)
  await page.getByRole("button", { name: "Unlock all", exact: true }).click()
  await expect.poll(() => state.lockWrites.length).toBe(3)
  expect(state.lockWrites[2]!.body).toEqual({ locks: [], inherit: "own" })
})

test("a session's permissions show the agent's rules it does not override, then its own", async ({ page }) => {
  const state = await mockOperator(page)
  state.locks.build = { locks: [{ permission: "webfetch", pattern: "*" }], inherit: "own" }
  state.sessionRules.ses_op_1 = [{ permission: "read", pattern: "*.env", action: "allow", origin: "user" }]
  await page.goto(`/operator/sessions${dir}&session=ses_op_1&stab=permissions`)
  const agent = page.getByTestId("session-permissions-agent")
  await expect(agent).toContainText("From the agent (build)")
  // The agent's `read *.env` is overridden by the session's: it is not listed here.
  await expect(agent.getByRole("row", { name: /\*\.env/ })).toHaveCount(0)
  await expect(agent.getByRole("row", { name: /webfetch/ }).getByTestId("rule-locked")).toHaveText("Locked")
  const own = page.getByTestId("session-permissions-own")
  await expect(own.getByTestId("session-overrides")).toContainText(
    "read *.env allow overrides the agent's #3 read *.env ask",
  )

  // Every rule locked: nothing to change.
  state.locks.build = {
    locks: [
      { permission: "*", pattern: "*" },
      { permission: "question", pattern: "*" },
      { permission: "read", pattern: "*.env" },
      { permission: "webfetch", pattern: "*" },
      { permission: "external_directory", pattern: "/tmp/opencode/tool-output/*" },
    ],
    inherit: "own",
  }
  await page.reload()
  await expect(page.getByTestId("session-permissions-own")).toContainText(
    "This agent doesn't let sessions change its permissions.",
  )
})

test("a locked request has no Allow for session, and says why", async ({ page }) => {
  const state = await mockOperator(page)
  state.pending = [{ ...state.pending[0]!, lockedBy: { permission: "bash", pattern: "git push*", action: "ask" } }]
  await page.goto("/operator/inbox?ask=per_op_1")
  const card = page.getByTestId("reply-card")
  await expect(card.getByRole("button", { name: "Allow for session" })).toBeDisabled()
  await expect(card.getByTestId("reply-locked")).toContainText("The agent locks bash git push* ask")
})

test("a subagent's locks can include its parent's", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("helper")
  // Shown for an agent that can run as a subagent (a new agent is both, by default), not for a primary one.
  await expect(page.getByRole("button", { name: "Own (default)" })).toBeVisible()
  await page.getByRole("button", { name: "Primary", exact: true }).click()
  await expect(page.getByRole("button", { name: "Own (default)" })).toHaveCount(0)
  await page.getByRole("button", { name: "Subagent", exact: true }).click()
  await page.getByRole("button", { name: "Own + parent's" }).click()
  await page.getByRole("button", { name: "Create agent" }).click()
  await expect.poll(() => state.lockWrites.length).toBe(1)
  expect(state.lockWrites[0]).toEqual({ agent: "helper", body: { locks: [], inherit: "parent" } })
})

test("the chat's … menu opens the session's permissions", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await mockOperator(page)
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${fixture.targetID}`)
  await page.getByRole("button", { name: "More options" }).first().click()
  await page.getByRole("menuitem", { name: /Session permissions/ }).click()
  const dialog = page.getByTestId("session-menu-permissions")
  await expect(dialog.getByTestId("session-permissions-agent")).toBeVisible()
  await expect(dialog.getByTestId("session-permissions-own")).toBeVisible()
})
