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
  }) => Promise<ReadonlyMap<string, { text: string; trace: unknown }>>
} = {}
