// Strings for this fork's additions (merge, operator console, adapters). They live here rather than
// in the upstream locale files so that upstream releases merge without conflicts. Every locale
// falls back to these English strings; add per-locale fork dictionaries here when translating.
export const dict = {
  "session.merge.indicator": "merged: {{adapter}} · {{id}} · {{status}}",
  "session.merge.running": "running",
  "session.merge.copyId": "Copy {{adapter}} session ID",
  "session.merge.copied": "Session ID copied",
  "session.merge.detach": "Detach from {{adapter}}",

  "settings.adapters.title": "Adapters",
  "settings.adapters.description":
    "Adapters let a session hand its turns to another coding agent with /merge. Turning one off stops new and attached sessions from using it.",
  "settings.adapters.recheck": "Check again",
  "settings.adapters.status.ready": "Ready",
  "settings.adapters.status.missing": "Not installed",
  "settings.adapters.status.off": "Off",
  "settings.adapters.version": "Version {{version}}",
  "settings.adapters.usage": "Use /merge {{id}} in a session",
  "settings.adapters.toggle": "Turn {{name}} on or off",
  "settings.adapters.empty": "This server has no adapters.",
  "settings.adapters.loadFailed": "Couldn't load adapters: {{message}}",
  "settings.adapters.saveFailed": "Couldn't change {{name}}",

  "operator.nav.label": "Operator",
  "operator.nav.chat": "Chat",
  "operator.nav.collapse": "Collapse sidebar",
  "operator.nav.expand": "Expand sidebar",
  "operator.nav.settings": "Settings",
  "operator.command.category": "Operator",
  "operator.command.go": "Go to {{page}}",
  "operator.planned.badge": "Planned",
  "operator.planned.title": "Coming soon",
  "operator.table.empty": "Nothing to show",
  "operator.table.columns": "Columns",
  "operator.scope.label": "Where to save",
  "operator.scope.global": "Global",
  "operator.scope.project": "This project",
  "operator.scope.all": "All projects",
  "operator.scope.picker": "Project",
  "operator.live.on": "Live",
  "operator.live.off": "Paused",

  "operator.page.dashboard.title": "Dashboard",
  "operator.page.dashboard.description": "Health, activity and cost across your projects at a glance.",
  "operator.page.dashboard.planned":
    "Tiles for server health, active sessions, turns, tool calls, tokens and cost, with recent sessions and pending approvals.",
  "operator.page.agents.title": "Agents",
  "operator.page.agents.description": "Every agent your projects can use, where it is defined and how it is set up.",
  "operator.page.agents.planned":
    "A table of agents with their model, mode and sessions, and forms to create, edit and remove agents, including their prompt, permissions, tools, hooks and home folder.",
  "operator.page.sessions.title": "Sessions",
  "operator.page.sessions.description": "Sessions across all projects, with search and filters.",
  "operator.page.sessions.planned":
    "A session table across projects with filters for project, agent and date, bulk archive, and an inspector for each session's context, permissions and live events.",
  "operator.page.inbox.title": "Permission Inbox",
  "operator.page.inbox.description":
    "Approvals waiting in every session, the rules you have remembered, and a history of decisions.",
  "operator.page.inbox.planned":
    "Pending approvals grouped by agent and session, remembered rules you can review and remove, and a history of every decision.",
  "operator.page.observability.title": "Observability",
  "operator.page.observability.description": "Live activity, tool calls, server logs and hook output.",
  "operator.page.observability.planned":
    "Live streams of tool activity, logs and hook output with filters, plus charts of turns, tokens and cost.",
  "operator.page.config.title": "Config",
  "operator.page.config.description": "Global and project settings, and where each value comes from.",
  "operator.page.config.planned":
    "Settings forms for each section, badges for values set in this project, reset to the inherited value, and a raw JSONC editor.",
  "operator.page.profile.title": "Prompt Profile",
  "operator.page.profile.description": "The identity and instruction layers that every agent's system prompt is built from.",
  "operator.page.profile.planned": "Organization, user and project prompt layers you can write, reorder and preview for each agent.",
  "operator.page.models.title": "Providers & Models",
  "operator.page.models.description": "Connected providers and the models they offer, with limits and prices.",
  "operator.page.models.planned": "Provider connections, a model catalog with context limits and prices, and options for each model.",
  "operator.page.capabilities.title": "Capabilities",
  "operator.page.capabilities.description": "Tools, skills, MCP servers, commands and sub-agents.",
  "operator.page.capabilities.planned":
    "Tools grouped by where they come from, editors for skills and prompt templates, MCP servers you can add and connect, and which sub-agents each agent can call.",
  "operator.page.integrations.title": "Integrations",
  "operator.page.integrations.description": "Chat channels, such as Telegram, that talk to your sessions.",
  "operator.page.integrations.planned":
    "Channel setup, chat-to-session links and allowlists, starting with a two-way Telegram bridge with approval buttons.",
  "operator.page.memory.title": "Memory",
  "operator.page.memory.description": "What agents remember between sessions.",
  "operator.page.memory.planned": "Browse, search, pin and forget what agents remember, globally, per project or per agent.",
}
