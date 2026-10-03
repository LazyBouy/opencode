import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

// The suite pins oc-2 through storageState; these tests start from an empty store to exercise the
// iphi default the way a first-time user sees it.
test.use({ storageState: { cookies: [], origins: [] } })

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

test("a first visit uses the iphi theme with its accent, backdrop and fonts", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "iphi")
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--v2-background-bg-accent").trim(),
      ),
    )
    .toBe("#FF6600")
  const styles = await page.evaluate(() => ({
    deep: getComputedStyle(document.documentElement).getPropertyValue("--v2-background-bg-deep").trim(),
    font: getComputedStyle(document.body).fontFamily,
  }))
  expect(styles.deep).toBe("#E5E6E8")
  expect(styles.font).toContain("Work Sans")
})

test("a saved theme choice still wins over the iphi default", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("opencode-theme-id", "oc-2"))
  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oc-2")
  const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
  expect(font).not.toContain("Work Sans")
})
