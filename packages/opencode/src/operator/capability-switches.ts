export * as OperatorCapabilitySwitches from "./capability-switches"

import path from "path"
import { parsePluginSpecifier } from "@/plugin/shared"
import { isRecord } from "@/util/record"

// The fork's own switches for capabilities OpenCode has none for (capability_scopes_spec.md §5): config
// `capabilities.disabled.commands` and `.plugins`. Commands are removed where command/index.ts builds
// its list (one line, so OpenCode's built-ins, MCP prompts and skills go too); plugins are left out
// where Config finishes merging (one line in config/config.ts).
// Kept free of service imports: config/config.ts imports it.

// A plugin's name: its package for npm specs, its file name for local files.
export function pluginName(spec: string) {
  if (spec.startsWith("file://") || spec.startsWith("/") || spec.startsWith("."))
    return path.basename(spec.replace(/^file:\/\//, ""), path.extname(spec))
  return parsePluginSpecifier(spec).pkg
}

const specOf = (entry: unknown) =>
  typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : undefined

// The commands or plugins `capabilities.disabled` turns off.
export function disabledList(config: unknown, kind: "commands" | "plugins"): string[] {
  const list =
    isRecord(config) && isRecord(config.capabilities) && isRecord(config.capabilities.disabled)
      ? config.capabilities.disabled[kind]
      : undefined
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []
}

// The merged config without the plugins it turns off.
export function withoutDisabledPlugins<T extends { plugin?: unknown[]; plugin_origins?: Array<{ spec: unknown }> }>(
  config: T,
): T {
  const off = new Set(disabledList(config, "plugins"))
  if (!off.size) return config
  const keep = (entry: unknown) => {
    const spec = specOf(entry)
    return !spec || !off.has(pluginName(spec))
  }
  return {
    ...config,
    ...(config.plugin ? { plugin: config.plugin.filter(keep) } : {}),
    ...(config.plugin_origins ? { plugin_origins: config.plugin_origins.filter((item) => keep(item.spec)) } : {}),
  }
}

// Removes the commands `capabilities.disabled` turns off from a command list (config's `command`, or
// command/index.ts's whole list: built-ins, MCP prompts and skills too), but never the reserved ones.
export function removeDisabledCommands(config: unknown, reserved: ReadonlyArray<string> = []) {
  if (!isRecord(config) || !isRecord(config.command)) return
  for (const name of disabledList(config, "commands")) if (!reserved.includes(name)) delete config.command[name]
}
