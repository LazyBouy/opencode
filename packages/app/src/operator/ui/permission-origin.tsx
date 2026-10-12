import type { OperatorPermissionOrigin } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { formatDateTime, shortPath } from "../format"

// Where a permission rule comes from, as a short label: OpenCode's code (its defaults, its definition
// of the agent, the truncation folder), a config file's `permission` or legacy `tools`, the agent's own
// rules (its file or config entry, or saved since the project loaded), the session's own rules with who
// added them and when, or a locked rule.
export function useOriginText() {
  const language = useLanguage()
  return (origin: OperatorPermissionOrigin) => {
    const path = origin.path ? shortPath(origin.path) : ""
    const time = origin.time ? formatDateTime(origin.time, language.intl()) : ""
    switch (origin.kind) {
      case "opencode-default":
        return language.t("operator.origin.opencodeDefault")
      case "opencode-agent":
        return language.t("operator.origin.opencodeAgent", { agent: origin.agent ?? "" })
      case "config-permission":
        return language.t("operator.origin.configPermission", { path })
      case "config-tools":
        return language.t("operator.origin.configTools", { path })
      case "agent":
        return path ? language.t("operator.origin.agentIn", { path }) : language.t("operator.origin.agent")
      case "truncation":
        return language.t("operator.origin.truncation")
      case "session-user":
        return language.t("operator.origin.sessionUser")
      case "session-always":
        return time
          ? language.t("operator.origin.sessionAlwaysAt", { time })
          : language.t("operator.origin.sessionAlways")
      case "session-allow":
        return time
          ? language.t("operator.origin.sessionAllowAt", { time })
          : language.t("operator.origin.sessionAllow")
      case "session-task":
        return language.t("operator.origin.sessionTask")
      case "session-client":
        return time
          ? language.t("operator.origin.sessionClientAt", { time })
          : language.t("operator.origin.sessionClient")
      case "session-opencode":
        return language.t("operator.origin.sessionOpencode")
      case "session-incognito":
        return language.t("operator.origin.sessionIncognito")
      case "agent-written":
        return language.t("operator.origin.agentWritten")
      case "lock":
        return language.t("operator.origin.lock")
    }
  }
}
