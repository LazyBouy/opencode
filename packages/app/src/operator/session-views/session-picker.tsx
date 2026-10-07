import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOpenSession, useOperatorClient } from "../data"
import { formatAgo } from "../format"
import { requestError } from "../pages/config-helpers"
import { useOperatorProjects } from "../project"

type SessionInfo = { id: string; agent?: string; directory: string; parentID?: string }

// The session page's agent menu (top left of the chat, the fork line in message-timeline.tsx's title
// row): the agent's sessions in this project, its main and active ones marked, to open another (in
// its own tab, or the tab it is open in) or start a new one. Several sessions of one agent can be open.
export function SessionPicker(props: { session: SessionInfo }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const openSession = useOpenSession()
  const projects = useOperatorProjects()
  const agent = () => props.session.agent ?? ""
  // The project the session belongs to: the longest project folder it is in.
  const project = createMemo(() => {
    const folder = props.session.directory
    const found = projects()
      .filter((item) => folder === item.directory || folder.startsWith(`${item.directory}/`))
      .sort((a, b) => b.directory.length - a.directory.length)[0]
    return found ?? { directory: folder, label: folder }
  })
  const sessions = useQuery(() => ({
    queryKey: api.key("sessions", "picker", project().directory, agent()),
    enabled: !!agent(),
    queryFn: () =>
      api
        .client()
        .operator.session.list({ within: project().directory, agent: agent(), roots: "true", limit: "100" })
        .then((result) => result.data ?? []),
  }))
  const state = useQuery(() => ({
    queryKey: api.key("agent-session-state", project().directory, agent()),
    enabled: !!agent(),
    queryFn: () =>
      api
        .client()
        .operator.agentSessions.state({ name: agent(), directory: project().directory })
        .then((result) => result.data!),
  }))
  const start = () =>
    api
      .client()
      .session.create({ directory: props.session.directory, agent: agent() }, { throwOnError: true })
      .then((result) => openSession(result.data.id))
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.chat.failed"), description: requestError(error) }),
      )

  return (
    <Show when={agent()}>
      <MenuV2 gutter={6} modal={false} placement="bottom-start">
        <MenuV2.Trigger
          as={ButtonV2}
          size="small"
          variant="ghost"
          data-testid="session-picker"
          aria-label={language.t("operator.chats.sessionsOf", { agent: agent() })}
          title={language.t("operator.chats.sessionsOf", { agent: agent() })}
        >
          <span class="inline-flex items-center gap-1">
            {agent()}
            <Icon name="chevron-down" size="small" />
          </span>
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content data-testid="session-picker-menu" class="max-h-[60vh] overflow-y-auto">
            <MenuV2.Group>
              <MenuV2.GroupLabel>
                {language.t("operator.chats.sessionsIn", { agent: agent(), project: project().label })}
              </MenuV2.GroupLabel>
              <MenuV2.RadioGroup value={props.session.id}>
                <For
                  each={sessions.data ?? []}
                  fallback={
                    <MenuV2.Item disabled>
                      {sessions.isPending ? language.t("common.loading") : language.t("operator.chats.none")}
                    </MenuV2.Item>
                  }
                >
                  {(item) => (
                    <MenuV2.RadioItem
                      value={item.id}
                      onSelect={() => item.id !== props.session.id && openSession(item.id)}
                      badge={
                        state.data?.main?.id === item.id
                          ? language.t("operator.agent.main")
                          : state.data?.active?.id === item.id
                            ? language.t("operator.agent.active")
                            : formatAgo(item.time.updated, language.intl())
                      }
                    >
                      <span class="block max-w-[320px] truncate">{item.title || item.id}</span>
                    </MenuV2.RadioItem>
                  )}
                </For>
              </MenuV2.RadioGroup>
            </MenuV2.Group>
            <MenuV2.Separator />
            <MenuV2.Item onSelect={() => void start()}>
              {language.t("operator.chats.newSession", { agent: agent() })}
            </MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </Show>
  )
}
