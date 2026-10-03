// Strings for this fork's additions (merge, operator console, adapters). They live here rather than
// in the upstream locale files so that upstream releases merge without conflicts. Every locale
// falls back to these English strings; add per-locale fork dictionaries here when translating.
export const dict = {
  "session.merge.indicator": "merged: {{adapter}} · {{id}} · {{status}}",
  "session.merge.running": "running",
  "session.merge.copyId": "Copy {{adapter}} session ID",
  "session.merge.copied": "Session ID copied",
  "session.merge.detach": "Detach from {{adapter}}",
}
