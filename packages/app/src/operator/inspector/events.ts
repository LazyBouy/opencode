// Picks the session an event belongs to, for the inspector's live event list. Session events carry it
// as `sessionID`, `info.sessionID` (messages) or `part.sessionID` (parts); session updates as `info.id`.
export function eventSession(type: string, properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object") return
  const value = properties as {
    sessionID?: unknown
    info?: { sessionID?: unknown; id?: unknown }
    part?: { sessionID?: unknown }
  }
  if (typeof value.sessionID === "string") return value.sessionID
  if (typeof value.info?.sessionID === "string") return value.info.sessionID
  if (typeof value.part?.sessionID === "string") return value.part.sessionID
  if (type.startsWith("session.") && typeof value.info?.id === "string") return value.info.id
}
