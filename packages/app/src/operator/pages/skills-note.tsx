import { useNavigate } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { type Block, type Inline, type Item, parse } from "../ui/note-text"
import { useAgents } from "./agents"

// Capabilities → Skills: "How skills reach an agent" (skills_rules_note_spec.md), closed by default and
// remembered per browser. The text is one string in en.ts; its two examples can be copied, and it links
// to an agent's Permissions and to Config.
const KEY = "opencode.operator.skillsNote"

function stored() {
  try {
    return localStorage.getItem(KEY) === "open"
  } catch {
    return false
  }
}

export function SkillsNote(props: { directory: string }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const agents = useAgents()
  const [open, setOpen] = createSignal(stored())
  const toggle = (next: boolean) => {
    setOpen(next)
    try {
      localStorage.setItem(KEY, next ? "open" : "closed")
    } catch {
      // Kept until the page reloads.
    }
  }
  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() =>
        showToast({ variant: "success", icon: "circle-check", title: language.t("operator.skillsNote.copied") }),
      )
      .catch(() => showToast({ title: language.t("operator.toolPrompt.copyFailed") }))

  const link = (target: string, children: JSX.Element) => {
    if (target === "config")
      return (
        <button
          type="button"
          data-slot="operator-link"
          onClick={() => navigate(`/operator/config?dir=${encodeURIComponent(props.directory)}`)}
        >
          {children}
        </button>
      )
    // An agent's Permissions, picked by name.
    return (
      <MenuV2 gutter={4} modal={false} placement="bottom-start">
        <MenuV2.Trigger as="button" type="button" data-slot="operator-link">
          {children}
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Group>
              <MenuV2.GroupLabel>{language.t("operator.skillsNote.pickAgent")}</MenuV2.GroupLabel>
              <For
                each={(agents.data ?? []).filter((agent) => !agent.hidden)}
                fallback={<MenuV2.Item disabled>{language.t("operator.skillsNote.noAgents")}</MenuV2.Item>}
              >
                {(agent) => (
                  <MenuV2.Item
                    onSelect={() =>
                      navigate(
                        `/operator/agents?agent=${encodeURIComponent(agent.name)}&adir=${encodeURIComponent(props.directory)}&atab=permissions`,
                      )
                    }
                  >
                    {agent.name}
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Group>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    )
  }

  const text = (parts: Inline[]): JSX.Element => (
    <For each={parts}>
      {(part) => (
        <Switch>
          <Match when={part.kind === "text" && part}>{(found) => found().text}</Match>
          <Match when={part.kind === "code" && part}>{(found) => <code>{found().text}</code>}</Match>
          <Match when={part.kind === "bold" && part}>{(found) => <strong>{text(found().children)}</strong>}</Match>
          <Match when={part.kind === "link" && part}>{(found) => link(found().target, text(found().children))}</Match>
        </Switch>
      )}
    </For>
  )
  const list = (items: Item[]): JSX.Element => (
    <ul>
      <For each={items}>
        {(item) => (
          <li>
            {text(item.text)}
            <Show when={item.items.length}>{list(item.items)}</Show>
          </li>
        )}
      </For>
    </ul>
  )
  const block = (item: Block): JSX.Element => (
    <Switch>
      <Match when={item.kind === "heading" && item}>{(found) => <h3>{text(found().text)}</h3>}</Match>
      <Match when={item.kind === "paragraph" && item}>{(found) => <p>{text(found().text)}</p>}</Match>
      <Match when={item.kind === "list" && item}>{(found) => list(found().items)}</Match>
      <Match when={item.kind === "code" && item}>
        {(found) => (
          <div data-slot="operator-note-code">
            <pre>
              <code>{found().text}</code>
            </pre>
            <ButtonV2 size="small" variant="outline" onClick={() => copy(found().text)}>
              {language.t("operator.skillsNote.copy")}
            </ButtonV2>
          </div>
        )}
      </Match>
    </Switch>
  )

  return (
    <details
      data-component="operator-skills-note"
      open={open()}
      onToggle={(event) => {
        if (event.currentTarget.open !== open()) toggle(event.currentTarget.open)
      }}
    >
      <summary>
        <Icon name="help" size="small" />
        <span>{language.t("operator.skillsNote.summary")}</span>
      </summary>
      <Show when={open()}>
        <div data-slot="operator-skills-note-body">
          <For each={parse(language.t("operator.skillsNote.text"))}>{block}</For>
        </div>
      </Show>
    </details>
  )
}
