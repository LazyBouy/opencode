// The server's refusal of a project write that would copy its namespace's config without consent
// (global_and_opencode_namespaces_spec.md §7.3; project-config-copy.tsx asks, then repeats it).

export type CopyNeeded = { message: string; project: string; namespace: string; file: string }

export function copyNeeded(error: unknown): CopyNeeded | undefined {
  // The SDK throws an Error with the response body as its cause (sdk/js/src/error-interceptor.ts).
  const cause = error instanceof Error ? (error.cause as { body?: unknown } | undefined) : undefined
  const body = cause && typeof cause === "object" && "body" in cause ? cause.body : error
  if (!body || typeof body !== "object") return undefined
  const value = body as { name?: unknown; data?: Partial<CopyNeeded> }
  if (value.name !== "OperatorProjectConfigCopyNeededError" || typeof value.data?.file !== "string") return undefined
  return value.data as CopyNeeded
}
