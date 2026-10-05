import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { OperatorProjects } from "../projects"

// Every session, and the agents it runs, belongs to one project. This server-wide middleware runs
// before upstream's routes and refuses to start a session in a folder that is not part of a project
// (see OperatorProjects): a new session (POST /session, POST /api/session) or a fork of one in such a
// folder. Everything else passes through untouched, so upstream's routes stay as they are.

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

    return (effect) =>
      Effect.gen(function* () {
        if (!OperatorProjects.guarded()) return yield* effect
        const request = yield* HttpServerRequest.HttpServerRequest
        const folder = yield* folderOf(request, new URL(request.url, "http://localhost"))
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
