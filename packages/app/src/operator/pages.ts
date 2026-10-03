import type { Icon } from "@opencode-ai/ui/icon"
import type { ComponentProps } from "solid-js"

type IconName = ComponentProps<typeof Icon>["name"]

export interface OperatorPage {
  readonly id:
    | "dashboard"
    | "agents"
    | "sessions"
    | "inbox"
    | "observability"
    | "config"
    | "profile"
    | "models"
    | "capabilities"
    | "integrations"
    | "memory"
  readonly path: string
  readonly icon: IconName
}

// The operator console's pages, in sidebar order. Routes, the sidebar and the command palette all
// read this list, so a new page is added here once.
export const operatorPages: readonly OperatorPage[] = [
  { id: "dashboard", path: "/operator", icon: "dot-grid" },
  { id: "agents", path: "/operator/agents", icon: "brain" },
  { id: "sessions", path: "/operator/sessions", icon: "bullet-list" },
  { id: "inbox", path: "/operator/inbox", icon: "shield" },
  { id: "observability", path: "/operator/observability", icon: "eye" },
  { id: "config", path: "/operator/config", icon: "sliders" },
  { id: "profile", path: "/operator/profile", icon: "prompt" },
  { id: "models", path: "/operator/models", icon: "providers" },
  { id: "capabilities", path: "/operator/capabilities", icon: "mcp" },
  { id: "integrations", path: "/operator/integrations", icon: "link" },
  { id: "memory", path: "/operator/memory", icon: "archive" },
]

export function isActivePage(page: OperatorPage, pathname: string) {
  const path = pathname.replace(/\/+$/, "") || "/"
  if (page.path === "/operator") return path === "/operator"
  return path === page.path || path.startsWith(`${page.path}/`)
}
