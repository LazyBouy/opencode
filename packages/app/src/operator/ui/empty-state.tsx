import { Icon } from "@opencode-ai/ui/icon"
import { type ComponentProps, type JSX, Show } from "solid-js"

export function EmptyState(props: {
  icon?: ComponentProps<typeof Icon>["name"]
  title: string
  description?: string
  action?: JSX.Element
}) {
  return (
    <div data-component="operator-empty">
      <Show when={props.icon}>{(icon) => <Icon name={icon()} />}</Show>
      <h2 data-slot="operator-empty-title">{props.title}</h2>
      <Show when={props.description}>
        <p data-slot="operator-empty-description">{props.description}</p>
      </Show>
      <Show when={props.action}>
        <div data-slot="operator-empty-action">{props.action}</div>
      </Show>
    </div>
  )
}
