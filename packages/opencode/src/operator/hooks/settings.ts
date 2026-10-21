export * as OperatorHookSettings from "./settings"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OperatorFileCache } from "../file-cache"

// Settings → Hooks (SPEC-0022 §10.5): the default timeout for hooks without their own, and Pause all hooks.
// Server-wide, kept with the fork's settings (the namespace store's folder), not in any config file.

export const DEFAULT_TIMEOUT = 5
export const MIN_TIMEOUT = 0.1
export const MAX_TIMEOUT = 600

export type Settings = { timeout: number; paused: boolean }

const file = () => path.join(Global.Path.config, "namespaces", "hook-settings.json")

const valid = (value: unknown): value is number =>
  typeof value === "number" && value >= MIN_TIMEOUT && value <= MAX_TIMEOUT

/** The settings now (read through the file cache: hooks fire on every tool and model call). */
export async function read(): Promise<Settings> {
  const value = (await OperatorFileCache.json(file())) as Partial<Settings> | undefined
  return {
    timeout: valid(value?.timeout) ? value.timeout : DEFAULT_TIMEOUT,
    paused: value?.paused === true,
  }
}

export class InvalidError extends Error {}

export async function write(patch: Partial<Settings>): Promise<Settings> {
  if (patch.timeout !== undefined && !valid(patch.timeout))
    throw new InvalidError(`The default timeout must be ${MIN_TIMEOUT} to ${MAX_TIMEOUT} seconds`)
  const next = { ...(await read()), ...patch }
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(next, null, 2) + "\n")
  return next
}
