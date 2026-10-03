// Keys whose values are credentials; the config view shows them masked.
const SECRET = /(api[_-]?key|token|secret|password|authorization)/i

export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET.test(key) && typeof item === "string" && item ? "••••••" : maskSecrets(item),
    ]),
  )
}

// The SDK throws the response body; operator errors carry a message in `data`.
export function requestError(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: unknown } }).data
    if (typeof data?.message === "string") return data.message
  }
  if (error instanceof Error) return error.message
  return String(error)
}
