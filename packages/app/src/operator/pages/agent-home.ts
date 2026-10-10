// An agent's home folder (memory_spec.md §2.3): absolute, or relative to its project, as the server's
// ensureMain resolves it.
export function homeFolder(project: string, home: string) {
  const joined = home.startsWith("/") ? home : `${project.replace(/\/+$/, "")}/${home}`
  const parts: string[] = []
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}
