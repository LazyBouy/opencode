export * as OperatorRegistry from "./registry"

// Fork services the prompt plugin calls. Plugins run outside Effect and cannot reach services, so a
// service registers here when the server builds it (and unregisters when it is torn down). Kept free
// of imports: the plugin module is imported by the session code these services import.

export const calls: {
  /**
   * Registers a model call about to be sent for a session (chat.headers); returns its id for the
   * provider tap's header, or nothing when calls are not recorded.
   */
  begin?: (input: {
    instance: unknown
    sessionID: string
    agent: string
    providerID: string
    modelID: string
    userMessageID?: string
    /** The request's Dynamic layers' resolutions (plugins.ts), stored with the call for the Transcript. */
    resolutions?: ReadonlyArray<unknown>
  }) => Promise<string | undefined>
} = {}

export const helperTexts: {
  /** The texts of your Dynamic layers (by id) for a request of a session of the request's project. */
  dynamic?: (input: {
    // The request's project instance (an InstanceContext), taken from the request's fiber.
    instance: unknown
    sessionID?: string
    layers: ReadonlyArray<string>
  }) => Promise<Record<string, string>>
} = {}

export const memory: {
  /**
   * What the memory tool needs for a call of a session (memory-service.ts): the folders of its three
   * levels, whether it runs incognito (a subagent: namespace and project memory only, never writing),
   * and each level's READ decision (a denied level is left out of `list`).
   */
  context?: (input: { instance: unknown; sessionID: string; agent: string }) => Promise<{
    project: string
    namespace: string
    folders: { namespace: string; project: string; agent?: string }
    incognito: boolean
    /** It may save, update and forget (not an incognito subagent; a helper run, at project or namespace level). */
    writes: boolean
    read: Record<"namespace" | "project" | "agent", "allow" | "ask" | "deny">
  }>
} = {}

export const dynamicLayers: {
  /**
   * OpenCode's per-request Dynamic layers (Environment, References, Instructions, MCP, Skills) resolved
   * through the pipeline for a request, by layer id, each with its text and trace (dynamic-layers.ts).
   */
  resolve?: (input: {
    instance: unknown
    agent: string
    model: unknown
    sessionID?: string
    sessionPermission?: unknown
    /** Upstream's instruction texts for this request (URLs are not fetched again). */
    instructions?: ReadonlyArray<string>
    /** The agent's layers with rules of their own (OperatorDynamicLayers.Custom), resolved by their id. */
    custom?: ReadonlyArray<{ layer: unknown; resolver: unknown }>
    /** The memory layers too (the agent's profile holds one). */
    memory?: boolean
  }) => Promise<ReadonlyMap<string, { text: string; trace: unknown }>>
} = {}

export const helpers: {
  /**
   * A helper's agent (helper-runs.ts) for a name OpenCode's Agent.get doesn't know (`helper:<ns>:<name>`): helpers
   * are never in OpenCode's agent list, so they stay out of `GET /config` and every agent list.
   */
  agent?: (name: string) => unknown
  /**
   * The model of the namespace's helper that took over a role OpenCode's code calls with a model of its choosing (the
   * agent generator, agent/agent.ts), for the project in `directory`; none without one.
   */
  roleModel?: (input: {
    directory: string
    role: string
  }) => Promise<{ providerID: string; modelID: string } | undefined>
  /** Runs one of the session's namespace's callable helpers, for the `helper` tool. */
  call?: (input: {
    instance: unknown
    sessionID: string
    agent: string
    name: string
    input: string
    abort: AbortSignal
  }) => Promise<{ output: string; run: string; sessionID?: string }>
  /**
   * Runs a helper in place of a built-in generator (a role, or a Dynamic layer's writer: helper-texts.ts) and gives
   * its output.
   */
  run?: (input: {
    instance: unknown
    namespace: string
    name: string
    input: string
    startedBy: { kind: "role" | "layer"; role?: string; layer?: string; sessionID?: string }
    parentSessionID?: string
  }) => Promise<string>
  /** The `helper` tool's description for an agent of this project: its namespace's callable helpers. */
  describe?: (input: { instance: unknown; agent: string }) => Promise<string | undefined>
  /** A system action of a helper run (list_sessions, archive_session, trash_session, notify). */
  action?: (input: {
    instance: unknown
    sessionID: string
    action: string
    args: Record<string, unknown>
  }) => Promise<string>
} = {}

export const telemetry: {
  /** A permission decision record was written (permission-decisions.ts): it ends the request's wait. */
  decision?: (record: unknown) => void
  /** A helper run ended (generate.ts), with its totals. */
  helper?: (run: unknown) => void
  /** Sessions moved to Trash (true) or restored from it (false) (trash.ts). */
  trash?: (sessionIDs: ReadonlyArray<string>, trashed: boolean) => void
  /**
   * Restoring a cleared store from Trash (trash.ts): the current store goes to Trash, then `restore` puts the files back
   * and the store opens them.
   */
  replaceStore?: (restore: () => Promise<void>) => Promise<void>
} = {}
