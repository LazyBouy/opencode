import { describe, expect, test } from "bun:test"
import { dayName, formsOf, newTrigger, runsByHand, triggersOf } from "./helper-trigger-model"

describe("helper trigger forms", () => {
  test("a new trigger is daily at 03:00 in this browser's zone, with no id yet", () => {
    expect(newTrigger("Europe/Berlin")).toMatchObject({ id: "", on: "daily", at: "03:00", tz: "Europe/Berlin" })
  })

  test("a trigger saves only what its kind uses; a schedule keeps its zone", () => {
    const forms = formsOf(
      [
        { id: "a1", on: "weekly", enabled: true, at: "04:30", day: 5, tz: "Asia/Tokyo", maxPerHour: 3 },
        { id: "b2", on: "session.untouched", enabled: false, days: 365 },
      ],
      "Europe/Berlin",
    )
    expect(forms[0]).toMatchObject({ at: "04:30", day: "5", tz: "Asia/Tokyo", maxPerHour: "3" })
    // An event gets this browser's zone, used only if it becomes a schedule.
    expect(forms[1]).toMatchObject({ days: "365", tz: "Europe/Berlin", maxPerHour: "20" })
    forms[1]!.input = "  Archive them.  "
    expect(triggersOf(forms)).toEqual([
      { id: "a1", on: "weekly", enabled: true, maxPerHour: 3, tz: "Asia/Tokyo", at: "04:30", day: 5 },
      { id: "b2", on: "session.untouched", enabled: false, input: "Archive them.", maxPerHour: 20, days: 365 },
    ])
  })

  test("Run now is for schedules and untouched sessions; weekdays are named in the browser's language", () => {
    expect(runsByHand("cron")).toBe(true)
    expect(runsByHand("session.untouched")).toBe(true)
    expect(runsByHand("session.turn")).toBe(false)
    expect(dayName(0, "en")).toBe("Sunday")
    expect(dayName(1, "en")).toBe("Monday")
  })
})
