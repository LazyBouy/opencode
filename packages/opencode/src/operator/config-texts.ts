export * as OperatorConfigTexts from "./config-texts"

// Descriptions of config options the schema has none for (config-reference.ts), keyed by option path. The schema's
// own description wins when it has one. A built-in agent's option (`agent.build.model`) or a legacy mode's reads
// as any agent's (`agent.<name>.model`), and the deprecated `reference.*` as `references.*`. After an upstream merge,
// an option that is new and undescribed fails the coverage test (test/operator/config-reference.test.ts) until it
// gets its text here.

export const TEXTS: Record<string, string> = {
  // Agents (also `mode`, deprecated).
  agent:
    "Agents: OpenCode's built-in ones (build, plan, general, explore, title, summary, compaction) and your own, by name",
  mode: "Agents, by name (the older name of `agent`)",
  "agent.<name>": "One agent's settings: an agent of your own, or changes to a built-in one",
  "agent.<name>.disable": "Turn the agent off: it isn't offered or used",
  "agent.<name>.mode": "How it is used: primary (you chat with it), subagent (other agents or @ call it) or all (both)",
  "agent.<name>.model": "The model it uses, as provider/model; without one, the default model",
  "agent.<name>.options": "Options passed to the model provider for this agent's requests",
  "agent.<name>.permission":
    "Its permission rules: allow, ask or deny, for every tool or per tool and pattern; they add to the global ones",
  "agent.<name>.prompt": "Its system prompt, or {file:path} to read it from a file",
  "agent.<name>.temperature": "Sampling temperature for its requests",
  "agent.<name>.tools.<name>": "Turn one tool on or off for this agent (prefer `permission`)",
  "agent.<name>.top_p": "Nucleus sampling (top P) for its requests",

  // Commands.
  "command.<name>": "A command of your own, run with /<name>",
  "command.<name>.agent": "The agent that runs it",
  "command.<name>.description": "What it does, shown in the command list",
  "command.<name>.model": "The model it runs with, as provider/model",
  "command.<name>.subtask": "Run it as a subtask (a subagent session) instead of in the chat",
  "command.<name>.template": "The prompt it sends; $ARGUMENTS and $1, $2… are replaced by what follows the command",
  "command.<name>.variant": "The model variant it runs with (for example a reasoning effort)",

  // Settings groups.
  compaction: "How long chats are compacted when their context fills up",
  enterprise: "OpenCode Enterprise settings",
  experimental: "Experimental features, which may change or go away",
  "experimental.disable_paste_summary": "Paste long text as it is instead of as a short summary of it",
  "experimental.policies[].action": "The action the statement covers, such as provider.use",
  "experimental.policies[].effect": "Whether the statement allows or denies the action",
  "experimental.policies[].resource": "What the statement applies to, such as a provider id; * for every one",
  tools: "Turn tools on or off for every agent (prefer `permission`)",
  "tools.<name>": "Turn one tool on or off for every agent",
  watcher: "The file watcher",
  "watcher.ignore": "Patterns of files and folders the file watcher ignores",
  permission:
    "Permission rules for every agent: allow, ask or deny, for every tool (one action) or per tool and pattern",
  plugin: "Plugins to load: npm package names (with an optional @version) or file paths",

  // MCP servers.
  "mcp.<name>": "An MCP server: a local command or a remote URL, by name",
  "mcp.<name>.enabled": "Turn the server on or off",

  // The fork's keys.
  "capabilities.disabled": "What this project or namespace turns off, though a farther scope adds it",
  "merge.adapters.<name>": "Settings for one /merge adapter, such as claude",

  // Providers.
  "provider.<id>": "One provider's settings: a built-in one's overrides, or a custom provider",
  "provider.<id>.api": "The provider's API base URL, as models.dev gives it",
  "provider.<id>.blacklist": "Its models to leave out",
  "provider.<id>.whitelist": "Its only models to offer",
  "provider.<id>.env": "Environment variables its API key can come from",
  "provider.<id>.id": "The provider's id",
  "provider.<id>.name": "The provider's name, as shown",
  "provider.<id>.npm": "The AI SDK package that talks to it, such as @ai-sdk/openai-compatible",
  "provider.<id>.options": "Options passed to its AI SDK package",
  "provider.<id>.options.apiKey": "Its API key, or {env:VARIABLE} to read it from the environment",
  "provider.<id>.options.baseURL": "The URL its requests go to (a proxy or a compatible server)",
  "provider.<id>.models": "Its models: overrides of the catalog's, or models of your own",
  "provider.<id>.models.<model>": "One model's settings",
  "provider.<id>.models.<model>.attachment": "It accepts files and images",
  "provider.<id>.models.<model>.cost": "Its prices, in dollars per million tokens",
  "provider.<id>.models.<model>.cost.input": "Price of input tokens, per million",
  "provider.<id>.models.<model>.cost.output": "Price of output tokens, per million",
  "provider.<id>.models.<model>.cost.cache_read": "Price of cached input tokens read, per million",
  "provider.<id>.models.<model>.cost.cache_write": "Price of input tokens written to the cache, per million",
  "provider.<id>.models.<model>.cost.context_over_200k": "Its prices once a request's context passes 200,000 tokens",
  "provider.<id>.models.<model>.cost.context_over_200k.input": "Price of input tokens, per million, past 200k",
  "provider.<id>.models.<model>.cost.context_over_200k.output": "Price of output tokens, per million, past 200k",
  "provider.<id>.models.<model>.cost.context_over_200k.cache_read":
    "Price of cached input tokens read, per million, past 200k",
  "provider.<id>.models.<model>.cost.context_over_200k.cache_write":
    "Price of input tokens written to the cache, per million, past 200k",
  "provider.<id>.models.<model>.experimental": "An experimental model, offered only when experimental models are on",
  "provider.<id>.models.<model>.family": "Its model family, such as claude or gpt",
  "provider.<id>.models.<model>.headers": "HTTP headers sent with its requests",
  "provider.<id>.models.<model>.headers.<header>": "One HTTP header's value",
  "provider.<id>.models.<model>.id": "Its id at the provider, when it differs from the key",
  "provider.<id>.models.<model>.interleaved":
    "It reasons between tool calls: true, or the response field its reasoning comes back in",
  "provider.<id>.models.<model>.limit": "Its token limits",
  "provider.<id>.models.<model>.limit.context": "Its context window, in tokens",
  "provider.<id>.models.<model>.limit.input": "The most input tokens a request may have",
  "provider.<id>.models.<model>.limit.output": "The most tokens it writes in one response",
  "provider.<id>.models.<model>.modalities": "What it reads and writes",
  "provider.<id>.models.<model>.modalities.input": "What it reads: text, image, audio, video, pdf",
  "provider.<id>.models.<model>.modalities.output": "What it writes: text, image, audio, video, pdf",
  "provider.<id>.models.<model>.name": "Its name, as shown",
  "provider.<id>.models.<model>.options": "Options passed to the provider for its requests",
  "provider.<id>.models.<model>.provider": "A different AI SDK package or URL for this model only",
  "provider.<id>.models.<model>.provider.api": "This model's API base URL",
  "provider.<id>.models.<model>.provider.npm": "The AI SDK package for this model",
  "provider.<id>.models.<model>.reasoning": "It reasons (thinks) before it answers",
  "provider.<id>.models.<model>.reasoning_options[].type":
    "The control: effort (named levels), toggle (thinking on or off) or budget_tokens (a token budget)",
  "provider.<id>.models.<model>.reasoning_options[].values": "For effort: the levels it accepts, such as low or high",
  "provider.<id>.models.<model>.reasoning_options[].min": "For budget_tokens: the smallest budget it accepts",
  "provider.<id>.models.<model>.reasoning_options[].max": "For budget_tokens: the largest budget it accepts",
  "provider.<id>.models.<model>.release_date": "When it was released (YYYY-MM-DD)",
  "provider.<id>.models.<model>.status": "Its status: alpha, beta, active or deprecated",
  "provider.<id>.models.<model>.temperature": "It accepts a temperature",
  "provider.<id>.models.<model>.tool_call": "It calls tools",
  "provider.<id>.models.<model>.variants.<variant>": "One variant's options, such as a reasoning effort",

  // References.
  "references.<name>": "A reference by name: a git repository or a local folder agents can read",
  "references.<name>.repository": "The git repository to clone",
  "references.<name>.branch": "The branch to check out",
  "references.<name>.path": "A local folder, instead of a repository",
  "references.<name>.description": "What it holds, shown to agents",
  "references.<name>.hidden": "Leave it out of the references agents are told about",
}
