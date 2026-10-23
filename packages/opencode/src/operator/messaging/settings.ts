export * as OperatorMessagingSettings from "./settings"

import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { OperatorFileCache } from "../file-cache"

// Settings → Messaging (SPEC-0023 §10.4): the rate limits per sending agent and the default wait of a `ping` that
// waits. Server-wide, kept with the fork's settings (the namespace store's folder), not in any config file, so no
// config key is added (RFC-0027). Read through the file cache: every send reads them.

export const Settings = Schema.Struct({
  perMinute: Schema.Finite.annotate({ description: "Sends a minute per sending agent: 1 to 1000 (default 30)" }),
  perHour: Schema.Finite.annotate({ description: "Sends an hour per sending agent: 1 to 10000 (default 300)" }),
  wait: Schema.Finite.annotate({
    description: "Seconds a ping that waits waits when it gives no timeout: 1 to 1800 (default 120)",
  }),
}).annotate({ identifier: "OperatorMessagingSettings" })
export type Settings = typeof Settings.Type

export const DEFAULTS: Settings = { perMinute: 30, perHour: 300, wait: 120 }
/** The longest wait, whatever is set. */
export const WAIT_MAX = 1800

const RANGES: Record<keyof Settings, [number, number]> = {
  perMinute: [1, 1000],
  perHour: [1, 10_000],
  wait: [1, WAIT_MAX],
}
const valid = (key: keyof Settings, value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= RANGES[key][0] && value <= RANGES[key][1]

const file = () => path.join(Global.Path.config, "namespaces", "messaging-settings.json")

export async function read(): Promise<Settings> {
  const value = (await OperatorFileCache.json(file())) as Partial<Settings> | undefined
  const pick = (key: keyof Settings) => (valid(key, value?.[key]) ? value![key]! : DEFAULTS[key])
  return { perMinute: pick("perMinute"), perHour: pick("perHour"), wait: pick("wait") }
}

export class InvalidError extends Error {}

export async function write(patch: Partial<Settings>): Promise<Settings> {
  for (const key of Object.keys(RANGES) as Array<keyof Settings>)
    if (patch[key] !== undefined && !valid(key, patch[key]))
      throw new InvalidError(`${key} must be a whole number from ${RANGES[key][0]} to ${RANGES[key][1]}`)
  const next = { ...(await read()), ...patch }
  if (next.perHour < next.perMinute) throw new InvalidError("An hour's limit can't be below a minute's")
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(next, null, 2) + "\n")
  return next
}
