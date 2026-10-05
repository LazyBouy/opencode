export * as OperatorRegistry from "./registry"

// Fork services the prompt plugin calls. Plugins run outside Effect and cannot reach services, so a
// service registers here when the server builds it (and unregisters when it is torn down). Kept free
// of imports: the plugin module is imported by the session code these services import.

export const helperTexts: {
  /** The texts of your Dynamic layers (by id) for a request of a session of the request's project. */
  dynamic?: (input: {
    // The request's project instance (an InstanceContext), taken from the request's fiber.
    instance: unknown
    sessionID?: string
    layers: ReadonlyArray<string>
  }) => Promise<Record<string, string>>
} = {}
