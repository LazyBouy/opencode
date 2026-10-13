export * as OperatorProjectIds from "./project-ids"

// A project's short id (specs/docs/issues/002): 5 lowercase base-32 characters (Crockford's alphabet: no i, l, o
// or u), random and unique on this server. It is made when the console records a project and kept with its
// entry in projects.json, so it survives a move or a rename (they rewrite paths, not ids). Upstream's project id
// isn't used: it is the git root commit, which two clones of one repository share.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
export const LENGTH = 5

export function make(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    const id = Array.from({ length: LENGTH }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join("")
    if (!taken.has(id)) return id
  }
}

export const valid = (value: unknown): value is string =>
  typeof value === "string" && value.length === LENGTH && [...value].every((char) => ALPHABET.includes(char))
