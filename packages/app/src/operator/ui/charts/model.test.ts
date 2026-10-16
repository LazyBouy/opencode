import { describe, expect, test } from "bun:test"
import { groupsOf } from "../../pages/observability/model"
import { csv, isoLocal, pick, stack } from "./model"

describe("chart rules", () => {
  test("stacks bottom first, keeping a step with no values empty", () => {
    expect(
      stack([
        [1, null, 2],
        [3, null, null],
        [1, null, 4],
      ]),
    ).toEqual([
      [1, null, 2],
      [4, null, 2],
      [5, null, 6],
    ])
  })

  test("a click lands on the stacked series under it, or the nearest line", () => {
    const series = [
      [2, 0],
      [3, 5],
      [1, 1],
    ]
    // Stack at step 0: 0–2, 2–5, 5–6.
    expect(pick(series, 0, 1, true)).toBe(0)
    expect(pick(series, 0, 4, true)).toBe(1)
    expect(pick(series, 0, 5.5, true)).toBe(2)
    // Above every bar: the top one.
    expect(pick(series, 0, 9, true)).toBe(2)
    // A zero-height series is never picked.
    expect(pick(series, 1, 0, true)).toBe(1)
    expect(pick(series, 0, 2.8, false)).toBe(1)
    expect(pick([[null], [null]], 0, 1, false)).toBe(-1)
  })

  test("CSV quotes what needs it and leaves empty values empty", () => {
    expect(
      csv(
        ["Time", "a,b"],
        [
          ["t1", 1],
          ["t2", null],
          ['say "hi"', 2],
        ],
      ),
    ).toBe('Time,"a,b"\nt1,1\nt2,\n"say ""hi""",2')
  })

  test("times carry their offset", () => {
    expect(isoLocal(0)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })

  test("the URL's group-by list reads back as section → key", () => {
    expect(groupsOf("turns:model,calls:provider,bad")).toEqual({ turns: "model", calls: "provider" })
    expect(groupsOf(undefined)).toEqual({})
  })
})
