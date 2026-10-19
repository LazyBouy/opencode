import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// observability_spec.md §18, §21.2: an axe check on each Observability tab finds no serious or critical violations
// (WCAG 2.1 A and AA), on what the page draws: its header, tabs, filters and the tab itself.

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

const TABS: Array<{ tab: string; ready: string }> = [
  { tab: "sessions", ready: '[data-testid="obs-session-row"]' },
  { tab: "events", ready: '[data-testid="obs-event-row"]' },
  { tab: "metrics", ready: '[data-testid="obs-chart"][data-metric="turns"] canvas' },
  { tab: "logs", ready: '[data-testid="obs-log-row"]' },
  { tab: "alerts", ready: '[data-testid="obs-alert-rule"]' },
]

for (const { tab, ready } of TABS)
  test(`the ${tab} tab has no serious accessibility violations`, async ({ page }) => {
    await mockOperator(page)
    await page.goto(`/operator/observability?tab=${tab}`)
    await expect(page.locator(ready).first()).toBeVisible()
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .include('[data-component="operator-page-header"]')
      .include('[data-slot="operator-obs-filterbar"]')
      .include('[data-component="operator-obs-layout"]')
      .analyze()
    const serious = result.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => ({
        rule: violation.id,
        help: violation.help,
        nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")),
      }))
    expect(serious).toEqual([])
  })
