import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { OperatorProjectRecords } from "../project-records"
import { OperatorProjects } from "../projects"

// Every session, and the agents it runs, belongs to one project. This server-wide middleware runs
// before upstream's routes and refuses to start a session in a folder that is not part of a project
// (see OperatorProjects): a new session (POST /session, POST /api/session) or a fork of one in such a
// folder. When the project names its members (its project-roles, see OperatorProjectRecords), it also
// refuses a session or a message (POST /session/:id/message, prompt_async, command) for an agent that is
// not one. OpenCode's helper agents are exempt, and subagents started by `task` never pass through here.
// Everything else passes through untouched, so upstream's routes stay as they are.

const HELPERS = new Set(["title", "summary", "compaction"])

const decode = (input: string) => {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const sessionGuardLayer = HttpRouter.middleware(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    // The folder a request starts a session in, or undefined when it starts none.
    const folderOf = (request: HttpServerRequest.HttpServerRequest, url: URL) =>
      Effect.gen(function* () {
        if (request.method !== "POST") return undefined
        // A session in a remote workspace is that workspace's business.
        if (url.searchParams.has("workspace")) return undefined
        if (url.pathname === "/session") {
          const header = request.headers["x-opencode-directory"]
          return url.searchParams.get("directory") || (header ? decode(header) : undefined) || process.cwd()
        }
        const fork = url.pathname.match(/^\/session\/([^/]+)\/fork$/)
        if (fork) {
          const row = yield* db
            .select({ directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, decode(fork[1]!) as typeof SessionTable.$inferSelect.id))
            .get()
            .pipe(Effect.orElseSucceed(() => undefined))
          return row?.directory
        }
        if (url.pathname === "/api/session") {
          const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""))
          const parsed = (() => {
            try {
              return JSON.parse(body) as { location?: { directory?: unknown } }
            } catch {
              return undefined
            }
          })()
          const directory = parsed?.location?.directory
          return typeof directory === "string" ? directory : process.cwd()
        }
        return undefined
      })

    // The agent a request starts or prompts a session as, and that session's folder.
    const agentOf = (request: HttpServerRequest.HttpServerRequest, url: URL) =>
      Effect.gen(function* () {
        if (request.method !== "POST" || url.searchParams.has("workspace")) return undefined
        const prompt = url.pathname.match(/^\/session\/([^/]+)\/(message|prompt_async|command)$/)
        if (url.pathname !== "/session" && !prompt) return undefined
        const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""))
        const agent = (() => {
          try {
            const value = (JSON.parse(body) as { agent?: unknown }).agent
            return typeof value === "string" && value ? value : undefined
          } catch {
            return undefined
          }
        })()
        if (!agent || HELPERS.has(agent)) return undefined
        if (!prompt) return { agent, folder: undefined }
        const row = yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, decode(prompt[1]!) as typeof SessionTable.$inferSelect.id))
          .get()
          .pipe(Effect.orElseSucceed(() => undefined))
        return row ? { agent, folder: row.directory } : undefined
      })

    const notMember = (agent: string, project: string) =>
      HttpServerResponse.jsonUnsafe(
        {
          name: "OperatorNotAMemberError",
          data: {
            agent,
            project,
            message: `${agent} is not a member of the project ${project}. Add it to the project's members (Projects page in the web app), or use a member agent.`,
          },
        },
        { status: 403 },
      )

    return (effect) =>
      Effect.gen(function* () {
        if (!OperatorProjects.guarded()) return yield* effect
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const folder = yield* folderOf(request, url)
        // Members: the project of the new session, or of the session a message goes to.
        const asked = yield* agentOf(request, url)
        const where = folder ?? asked?.folder
        if (asked && where) {
          const owner = yield* Effect.promise(() => OperatorProjects.projectOf(where))
          if (owner && !(yield* Effect.promise(() => OperatorProjectRecords.allows(owner.key, asked.agent))))
            return notMember(asked.agent, owner.key)
        }
        if (folder === undefined) return yield* effect
        const project = yield* Effect.promise(() => OperatorProjects.projectOf(folder))
        if (project) return yield* effect
        return HttpServerResponse.jsonUnsafe(
          {
            name: "OperatorNotAProjectError",
            data: {
              directory: folder,
              message: `${folder} is not part of a project. Start the session in a project, or make this folder a project first (Projects page in the web app).`,
            },
          },
          { status: 409 },
        )
      })
  }),
  { global: true },
)
