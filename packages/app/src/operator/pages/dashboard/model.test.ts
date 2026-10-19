import { describe, expect, test } from "bun:test"
import { ageOf } from "../../format"
import { arrowOf, hrefOf, rangeOf, throttle, toneOf, trendOf } from "./model"

// dashboard_spec.md §4.4, §5.1, §6.2, §9.1: the range and its carry-over, links built from a page and parameters with
// the page's scope, ages, comparison tones (never colour alone: the arrow comes too), sparkline values, refresh limits.

describe("dashboard model", () => {
  test("the range: the URL's, the remembered one, the old days choice, else 14 days", () => {
    expect(rangeOf("7d", { range: "30d" })).toBe("7d")
    expect(rangeOf(undefined, { range: "30d" })).toBe("30d")
    expect(rangeOf(undefined, { days: 7 })).toBe("7d")
    expect(rangeOf("90d", { days: 3 })).toBe("14d")
  })

  test("links carry the scope (a namespace only into Observability) and a tile's range; their own parameters win", () => {
    expect(
      hrefOf(
        { page: "observability", params: { tab: "events", http: "429", range: "15m" } },
        { ns: "acme" },
        {
          range: "7d",
        },
      ),
    ).toBe("/operator/observability?ns=acme&range=15m&tab=events&http=429")
    expect(hrefOf({ page: "inbox", params: { ask: "per_1" } }, { ns: "acme", dir: "/w/a" })).toBe(
      "/operator/inbox?dir=%2Fw%2Fa&ask=per_1",
    )
    expect(
      hrefOf(
        { page: "capabilities", params: { dir: "/w/b", tab: "mcp", kind: "mcp", item: "github" } },
        { dir: "/w/a" },
      ),
    ).toBe("/operator/capabilities?dir=%2Fw%2Fb&tab=mcp&kind=mcp&item=github")
    expect(hrefOf({ page: "inbox", params: {} })).toBe("/operator/inbox")
  })

  test("ages in minutes, hours, then days", () => {
    expect(ageOf(20_000)).toEqual({ unit: "min", n: 1 })
    expect(ageOf(14 * 60_000)).toEqual({ unit: "min", n: 14 })
    expect(ageOf(3 * 3_600_000)).toEqual({ unit: "h", n: 3 })
    expect(ageOf(3 * 86_400_000)).toEqual({ unit: "d", n: 3 })
  })

  test("a change worse is the warning tone, better the good one; neutral tiles and no change stay neutral", () => {
    expect(toneOf("turnErrors", { kind: "points", value: 0.8 })).toBe("warn")
    expect(toneOf("turnTime", { kind: "relative", value: -9 })).toBe("good")
    expect(toneOf("turns", { kind: "relative", value: 12 })).toBe("neutral")
    expect(toneOf("cost", { kind: "relative", value: -5 })).toBe("neutral")
    expect(toneOf("rateLimits", { kind: "same" })).toBe("neutral")
    expect(arrowOf({ kind: "relative", value: 12 })).toBe("up")
    expect(arrowOf({ kind: "points", value: -0.8 })).toBe("down")
    expect(arrowOf({ kind: "insufficient" })).toBeUndefined()
  })

  test("sparkline values: sums read an empty step as 0, rates leave it out", () => {
    const series = [
      [1, 2],
      [2, null],
      [3, 4],
    ] as const
    expect(trendOf(series, true)).toEqual([2, 0, 4])
    expect(trendOf(series, false)).toEqual([2, 4])
  })

  test("a refresh on live events at most once per interval, the last of a burst at the end", async () => {
    let runs = 0
    const limited = throttle(() => runs++, 40)
    limited.call()
    limited.call()
    limited.call()
    expect(runs).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(runs).toBe(2)
    limited.cancel()
  })
})
