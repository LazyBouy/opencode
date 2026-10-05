import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useOperatorProjects } from "../project"

// An action in one project: a button when the page shows one project, else a menu of projects.
export function ProjectAction(props: {
  label: string
  directory: string | undefined
  variant?: "neutral" | "outline" | "contrast"
  size?: "small" | "normal"
  run: (directory: string) => void
}) {
  const language = useLanguage()
  const projects = useOperatorProjects()
  return (
    <Show
      when={!props.directory}
      fallback={
        <ButtonV2 size={props.size} variant={props.variant ?? "outline"} onClick={() => props.run(props.directory!)}>
          {props.label}
        </ButtonV2>
      }
    >
      <MenuV2 gutter={6} modal={false} placement="bottom-end">
        <MenuV2.Trigger as={ButtonV2} size={props.size} variant={props.variant ?? "outline"}>
          {props.label}
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Group>
              <MenuV2.GroupLabel>{language.t("operator.project.in")}</MenuV2.GroupLabel>
              <For each={projects()}>
                {(item) => <MenuV2.Item onSelect={() => props.run(item.directory)}>{item.label}</MenuV2.Item>}
              </For>
            </MenuV2.Group>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </Show>
  )
}
