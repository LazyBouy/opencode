export * as OperatorHelperTriggerRules from "./helper-trigger-rules"

import { Cron, Result } from "effect"
import type { OperatorHelperFiles } from "./helper-files"

// A helper's triggers (agent_types_spec.md §4.9), as rules with no service: checking them, the cron a schedule
// stands for (in the time zone saved with it, the browser's when it was set), when it is next due, and how it is
// named in a run's input and its Runs. helper-triggers.ts fires them.

type Trigger = OperatorHelperFiles.Trigger

export const SCHEDULES = ["hourly", "daily", "weekly", "cron"] as const
export const EVENTS = ["session.untouched", "session.turn", "project.created"] as const
export const MAX_PER_HOUR = { default: 20, min: 1, max: 200 } as const
export const UNTOUCHED_DAYS = { min: 1, max: 3650 } as const
/** Triggers a helper may have. */
export const MAX_TRIGGERS = 10
const INPUT_MAX = 4000
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

export const isSchedule = (trigger: Pick<Trigger, "on">) => (SCHEDULES as ReadonlyArray<string>).includes(trigger.on)

/** The cron a schedule stands for (minute hour day month weekday); none for an event. */
export function cronText(trigger: Trigger): string | undefined {
  if (trigger.on === "hourly") return `${trigger.minute ?? 0} * * * *`
  if (trigger.on === "daily" || trigger.on === "weekly") {
    const [hour, minute] = (trigger.at ?? "03:00").split(":").map(Number)
    return `${minute} ${hour} * * ${trigger.on === "weekly" ? (trigger.day ?? 1) : "*"}`
  }
  if (trigger.on === "cron") return trigger.cron?.trim()
  return undefined
}

function cronOf(trigger: Trigger): Result.Result<Cron.Cron, string> {
  const text = cronText(trigger)
  if (!text) return Result.fail("Not a schedule")
  if (text.split(" ").filter(Boolean).length !== 5)
    return Result.fail("A cron expression has 5 fields: minute hour day month weekday")
  return Cron.parse(text, trigger.tz || undefined).pipe(Result.mapError((error) => error.message))
}

/** When a schedule is next due after `after` (ms); none for an event or a schedule that can't be read. */
export function nextAt(trigger: Trigger, after: number): number | undefined {
  const cron = cronOf(trigger)
  if (Result.isFailure(cron)) return undefined
  return Cron.next(cron.success, new Date(after)).getTime()
}

/** What a schedule fires on: a change (another time, zone or cron) starts it afresh. */
export const signature = (trigger: Trigger) => `${cronText(trigger) ?? trigger.on}|${trigger.tz ?? ""}`

/** The trigger in words, for a run's input and its Runs: "daily at 03:00 (Europe/Berlin)". */
export function describe(trigger: Trigger): string {
  const zone = trigger.tz ? ` (${trigger.tz})` : ""
  if (trigger.on === "hourly") return `hourly at :${String(trigger.minute ?? 0).padStart(2, "0")}${zone}`
  if (trigger.on === "daily") return `daily at ${trigger.at ?? "03:00"}${zone}`
  if (trigger.on === "weekly") return `weekly on ${DAY_NAMES[trigger.day ?? 1]} at ${trigger.at ?? "03:00"}${zone}`
  if (trigger.on === "cron") return `cron ${trigger.cron?.trim() ?? ""}${zone}`
  if (trigger.on === "session.untouched") return `sessions untouched for ${trigger.days ?? 0} days`
  if (trigger.on === "session.turn") return "an agent finished a turn"
  return "a project was created"
}

const whole = (value: number | undefined, label: string, min: number, max: number) => {
  if (value === undefined || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${label} is a whole number from ${min} to ${max}`)
  return value
}

/**
 * The triggers as stored: each checked (throws a message for the first wrong one), with only the fields its kind
 * uses, and an id (kept, else made with `makeId`).
 */
export function check(triggers: ReadonlyArray<Trigger>, makeId: () => string): Trigger[] {
  if (triggers.length > MAX_TRIGGERS) throw new Error(`A helper has at most ${MAX_TRIGGERS} triggers`)
  const ids = new Set<string>()
  return triggers.map((trigger, index) => {
    const label = `Trigger ${index + 1}`
    if (![...SCHEDULES, ...EVENTS].includes(trigger.on as never)) throw new Error(`${label}: unknown "${trigger.on}"`)
    const id = /^[a-z0-9]{1,16}$/.test(trigger.id ?? "") && !ids.has(trigger.id) ? trigger.id : makeId()
    ids.add(id)
    const input = trigger.input?.trim()
    if (input && input.length > INPUT_MAX)
      throw new Error(`${label}: what to tell it is at most ${INPUT_MAX} characters`)
    const maxPerHour = whole(
      trigger.maxPerHour ?? MAX_PER_HOUR.default,
      `${label}: runs an hour`,
      MAX_PER_HOUR.min,
      MAX_PER_HOUR.max,
    )
    const base = { id, on: trigger.on, enabled: trigger.enabled, ...(input ? { input } : {}), maxPerHour }
    if (trigger.on === "session.untouched")
      return { ...base, days: whole(trigger.days, `${label}: days`, UNTOUCHED_DAYS.min, UNTOUCHED_DAYS.max) }
    if (!isSchedule(trigger)) return base
    if (!trigger.tz) throw new Error(`${label}: a schedule needs its time zone`)
    const at = trigger.at?.trim() ?? ""
    if ((trigger.on === "daily" || trigger.on === "weekly") && !HHMM.test(at))
      throw new Error(`${label}: the time is HH:MM, such as 03:00`)
    const schedule: Trigger = {
      ...base,
      tz: trigger.tz,
      ...(trigger.on === "hourly" ? { minute: whole(trigger.minute ?? 0, `${label}: the minute`, 0, 59) } : {}),
      ...(trigger.on === "daily" || trigger.on === "weekly" ? { at } : {}),
      ...(trigger.on === "weekly" ? { day: whole(trigger.day ?? 1, `${label}: the day`, 0, 6) } : {}),
      ...(trigger.on === "cron" ? { cron: trigger.cron?.trim() ?? "" } : {}),
    }
    const cron = cronOf(schedule)
    if (Result.isFailure(cron)) throw new Error(`${label}: ${cron.failure}`)
    return schedule
  })
}
