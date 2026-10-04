import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"

export type ProjectOption = { key: string; name: string }
export type Projects = "*" | ReadonlyArray<string>

// Which projects a prompt layer, group or profile applies to: all of them, or the chosen ones.
// `single` picks exactly one project (a project goal), leaving OpenCode out.
export function ProjectScope(props: {
  value: Projects
  projects: ReadonlyArray<ProjectOption>
  onChange: (value: Projects) => void
  disabled?: boolean
  single?: boolean
}) {
  const language = useLanguage()
  const chosen = () => (props.value === "*" ? [] : props.value)
  const toggle = (key: string, on: boolean) => {
    const next = on ? [...chosen(), key] : chosen().filter((item) => item !== key)
    props.onChange(next.length ? next : "*")
  }

  return (
    <Show
      when={!props.single}
      fallback={
        <SelectV2<ProjectOption>
          appearance="base"
          aria-label={language.t("operator.scope.picker")}
          disabled={props.disabled}
          options={[...props.projects]}
          current={props.projects.find((item) => item.key === chosen()[0])}
          value={(item) => item.key}
          label={(item) => item.name}
          placeholder={language.t("operator.profile.chooseProject")}
          onSelect={(item) => item && props.onChange([item.key])}
        />
      }
    >
      <div data-slot="operator-scope-list" role="group" aria-label={language.t("operator.profile.scope")}>
        <CheckboxV2
          label={language.t("operator.scope.all")}
          checked={props.value === "*"}
          disabled={props.disabled}
          onChange={(checked: boolean) => props.onChange(checked ? "*" : [props.projects[0]?.key ?? "opencode"])}
        />
        <Show when={props.value !== "*"}>
          <For each={props.projects}>
            {(project) => (
              <CheckboxV2
                label={project.name}
                checked={chosen().includes(project.key)}
                disabled={props.disabled}
                onChange={(checked: boolean) => toggle(project.key, checked)}
              />
            )}
          </For>
        </Show>
      </div>
    </Show>
  )
}

// "All projects", or the names of the chosen ones.
export function scopeLabel(value: Projects, projects: ReadonlyArray<ProjectOption>, all: string) {
  if (value === "*") return all
  return value.map((key) => projects.find((item) => item.key === key)?.name ?? key).join(", ")
}
