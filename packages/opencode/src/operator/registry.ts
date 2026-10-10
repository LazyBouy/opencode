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
  }) => Promise<ReadonlyMap<string, { text: string; trace: unknown }>>
} = {}
