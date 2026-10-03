import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Npm } from "@opencode-ai/core/npm"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MCP } from "@/mcp"
import { OperatorAgents } from "@/operator/agents"
import { OperatorTools } from "@/operator/tools"
import { Session } from "@/session/session"
import { NpmTest } from "../fake/npm"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const docs = new Client({ name: "docs", version: "1.0.0" })
const mcp = Layer.mock(MCP.Service)({
  clients: () => Effect.succeed({ docs }),
  tools: () =>
    Effect.succeed({
      docs_search: { def: { name: "search", description: "Search the docs", inputSchema: { type: "object" } }, client: docs },
    }),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      OperatorAgents.node,
      OperatorTools.node,
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      Database.node,
      CrossSpawnSpawner.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [MCP.node, mcp],
      [Npm.node, NpmTest.noop],
    ],
  ),
)

const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })

it.instance(
  "agents say where they are defined and how many sessions use them",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      yield* sessions.create({ title: "Review", agent: "reviewer" })

      const agents = yield* (yield* OperatorAgents.Service).list()
      const byName = new Map(agents.map((agent) => [agent.name, agent]))

      expect(byName.get("reviewer")?.source).toEqual({
        kind: "file",
        path: path.join(directory, ".opencode", "agents", "reviewer.md"),
        customized: false,
      })
      expect(byName.get("reviewer")?.description).toBe("Reviews diffs")
      expect(byName.get("reviewer")?.sessions.total).toBe(1)
      expect(byName.get("build")?.source).toMatchObject({ kind: "builtin", customized: true })
      expect(byName.get("plan")?.source).toMatchObject({ kind: "builtin", customized: false })
      expect(byName.get("plan")?.sessions).toEqual({ total: 0, lastUsed: undefined })
    }),
  {
    config: { agent: { build: { temperature: 0.2 } } },
    init: (directory) =>
      write(
        path.join(directory, ".opencode", "agents", "reviewer.md"),
        "---\ndescription: Reviews diffs\nmode: subagent\n---\nReview the diff.\n",
      ),
  },
)

it.instance(
  "tools say whether they are built in, custom or from an MCP server",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const tools = yield* (yield* OperatorTools.Service).list()
      const byID = new Map(tools.map((tool) => [tool.id, tool]))

      expect(byID.get("read")).toMatchObject({ origin: "builtin" })
      expect(byID.get("hello")).toMatchObject({
        origin: "custom",
        description: "hello tool",
        source: path.join(directory, ".opencode", "tools", "hello.ts"),
      })
      expect(byID.get("docs_search")).toEqual({
        id: "docs_search",
        description: "Search the docs",
        origin: "mcp",
        source: "docs",
      })
      expect(byID.has("invalid")).toBe(false)
    }),
  {
    init: (directory) =>
      write(
        path.join(directory, ".opencode", "tools", "hello.ts"),
        "export default {\n  description: 'hello tool',\n  args: {},\n  execute: async () => 'hello',\n}\n",
      ),
  },
)
