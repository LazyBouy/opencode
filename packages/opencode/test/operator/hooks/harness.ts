import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { OperatorHookSeams } from "@/operator/hooks/seams"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { replacements, root } from "../../merge/harness"
import { fakeConfig, fakeProvider } from "../fake-provider"

// Sessions with hooks (SPEC-0022), on a fake provider: the server's seams (operator/hooks/seams.ts) included.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
export const it = testEffect(
  LayerNode.compile(LayerNode.group([root, OperatorHookSeams.node]), [
    ...replacements,
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)
export const unix = process.platform !== "win32" ? it.instance : it.instance.skip

/**
 * A hook as a sh script that logs its session id, folder and stdin (one line a run) and prints its answer.
 * `body` replaces the answer with shell lines of its own (stdin is in `$input`).
 */
export type Hook = {
  event: string
  answer?: unknown
  body?: string[]
  match?: string[]
  onFailure?: string
  sleep?: number
}

export const setup = (hooks: Record<string, Hook>, extra: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const fake = yield* Effect.acquireRelease(
      Effect.sync(() => fakeProvider()),
      (item) => Effect.sync(() => item.stop()),
    )
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(directory, "hooks"), { recursive: true })
      for (const [name, hook] of Object.entries(hooks))
        await fs.writeFile(
          path.join(directory, "hooks", `${name}.sh`),
          [
            "#!/bin/sh",
            "input=$(cat)",
            ...(hook.sleep ? [`sleep ${hook.sleep}`] : []),
            `printf '%s\\t%s\\t%s\\n' "$OPENCODE_SESSION_ID" "$(pwd)" "$input" >> "${path.join(directory, "hooks", `${name}.log`)}"`,
            ...(hook.body ?? (hook.answer === undefined ? [] : ["cat <<'EOF'", JSON.stringify(hook.answer), "EOF"])),
          ].join("\n"),
        )
      await fs.writeFile(path.join(directory, "a.md"), "# a\n")
      await fs.writeFile(path.join(directory, "b.ts"), "export {}\n")
      await fs.writeFile(
        path.join(directory, "opencode.json"),
        JSON.stringify(
          fakeConfig(fake.url, {
            hooks: Object.fromEntries(
              Object.entries(hooks).map(([name, hook]) => [
                name,
                {
                  event: hook.event,
                  command: `hooks/${name}.sh`,
                  ...(hook.match ? { match: hook.match } : {}),
                  ...(hook.onFailure ? { onFailure: hook.onFailure } : {}),
                },
              ]),
            ),
            ...extra,
          }),
        ),
      )
    })
    return { directory, fake, sessions: yield* Session.Service }
  })

export const MODEL = { providerID: ProviderV2.ID.make("fakechat"), modelID: ModelV2.ID.make("chat-model") }

export const ask = (sessionID: Session.Info["id"], text: string, agent = "build") =>
  Effect.gen(function* () {
    return yield* (yield* SessionPrompt.Service).prompt({
      sessionID,
      agent,
      model: MODEL,
      parts: [{ type: "text", text }],
    })
  })

/** What each run of a hook was given: its session, its folder and its stdin. */
export const runsOf = (directory: string, name: string) =>
  Effect.promise(async () =>
    (await fs.readFile(path.join(directory, "hooks", `${name}.log`), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [session, cwd, input] = line.split("\t")
        return { session, cwd, input: JSON.parse(input!) as Record<string, any> }
      }),
  )

export const toolParts = (sessions: Session.Interface, sessionID: Session.Info["id"]) =>
  sessions
    .messages({ sessionID })
    .pipe(Effect.map((messages) => messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")))

/** The requests the agent made (not the title call), as sent. */
export const agentBodies = (fake: ReturnType<typeof fakeProvider>) =>
  fake.hits.map((hit) => hit.body).filter((body) => !body.includes("Generate a title for this conversation"))
