import type { Part } from "@opencode-ai/sdk/v2"

// A merged turn's summary restates the projected parts shown beside it; it exists for OpenCode's
// model, shares and exports, where those parts are left out. Kept in its own module (not
// message-part) so upstream tests that mock message-part keep working in this fork.
export function redundantMergeSummary(part: Part, parts: readonly Part[]) {
  return part.origin?.role === "summary" && parts.some((item) => item.origin?.role === "projection")
}
