import type { OperatorHelperTrigger, OperatorHelperTriggerOn } from "@opencode-ai/sdk/v2/client"

// A helper's triggers in its form (agent_types_spec.md §4.9; the server checks them: helper-trigger-rules.ts). A
// schedule keeps the time zone it was set in; a new one gets this browser's.

export const SCHEDULES: ReadonlyArray<OperatorHelperTriggerOn> = ["hourly", "daily", "weekly", "cron"]
export const EVENTS: ReadonlyArray<OperatorHelperTriggerOn> = ["session.untouched", "session.turn", "project.created"]
export const TRIGGER_ONS: ReadonlyArray<OperatorHelperTriggerOn> = [...SCHEDULES, ...EVENTS]
export const MAX_TRIGGERS = 10
export const MAX_PER_HOUR = 20

export const isSchedule = (on: OperatorHelperTriggerOn) => SCHEDULES.includes(on)
/** Run now starts a schedule or the untouched sessions' check; other events wait for theirs. */
export const runsByHand = (on: OperatorHelperTriggerOn) => isSchedule(on) || on === "session.untouched"

export type TriggerForm = {
  id: string
  on: OperatorHelperTriggerOn
  enabled: boolean
  at: string
  minute: string
  day: string
  cron: string
  tz: string
  days: string
  input: string
  maxPerHour: string
}

/** This browser's time zone, such as Europe/Berlin. */
export function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

export function newTrigger(zone: string): TriggerForm {
  return {
    id: "",
    on: "daily",
    enabled: true,
    at: "03:00",
    minute: "0",
    day: "1",
    cron: "0 3 * * *",
    tz: zone,
    days: "365",
    input: "",
    maxPerHour: String(MAX_PER_HOUR),
  }
}

export function formsOf(triggers: ReadonlyArray<OperatorHelperTrigger>, zone: string): TriggerForm[] {
  return triggers.map((trigger) => {
    const fresh = newTrigger(trigger.tz ?? zone)
    return {
      ...fresh,
      id: trigger.id,
      on: trigger.on,
      enabled: trigger.enabled,
      ...(trigger.at ? { at: trigger.at } : {}),
      ...(trigger.minute !== undefined ? { minute: String(trigger.minute) } : {}),
      ...(trigger.day !== undefined ? { day: String(trigger.day) } : {}),
      ...(trigger.cron ? { cron: trigger.cron } : {}),
      ...(trigger.days !== undefined ? { days: String(trigger.days) } : {}),
      input: trigger.input ?? "",
      maxPerHour: String(trigger.maxPerHour ?? MAX_PER_HOUR),
    }
  })
}

/** The triggers to save: each with only what its kind uses (a new one has no id yet). */
export function triggersOf(forms: ReadonlyArray<TriggerForm>): OperatorHelperTrigger[] {
  return forms.map((form) => ({
    id: form.id,
    on: form.on,
    enabled: form.enabled,
    ...(form.input.trim() ? { input: form.input.trim() } : {}),
    maxPerHour: Number(form.maxPerHour),
    ...(isSchedule(form.on) ? { tz: form.tz } : {}),
    ...(form.on === "hourly" ? { minute: Number(form.minute) } : {}),
    ...(form.on === "daily" || form.on === "weekly" ? { at: form.at.trim() } : {}),
    ...(form.on === "weekly" ? { day: Number(form.day) } : {}),
    ...(form.on === "cron" ? { cron: form.cron.trim() } : {}),
    ...(form.on === "session.untouched" ? { days: Number(form.days) } : {}),
  }))
}

/** A weekday's name in this browser's language: 0 is Sunday. */
export function dayName(day: number, locale?: string) {
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2023, 0, 1 + day)),
  )
}
