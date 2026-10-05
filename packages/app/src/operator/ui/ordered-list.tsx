import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { createSignal, For, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { move, moveTo } from "../pages/profile-model"

// An ordered list of ids that can be reordered by drag and drop or with up/down, and items removed.
// Locked items cannot be moved or removed; required ones can move but not be removed.
export function OrderedList(props: {
  label: string
  items: ReadonlyArray<string>
  name: (id: string) => string
  badge?: (id: string) => JSX.Element | undefined
  locked?: (id: string) => boolean
  required?: (id: string) => boolean
  disabled?: boolean
  onChange: (items: string[]) => void
}) {
  const language = useLanguage()
  const [dragging, setDragging] = createSignal<number>()
  const fixed = (id: string) => props.disabled || !!props.locked?.(id)

  return (
    <ol data-component="operator-layers" aria-label={props.label}>
      <For each={props.items}>
        {(id, index) => (
          <li
            data-slot="operator-layer"
            draggable={!fixed(id)}
            data-dragging={dragging() === index() ? "" : undefined}
            onDragStart={(event) => {
              setDragging(index())
              event.dataTransfer?.setData("text/plain", id)
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              const from = dragging()
              setDragging(undefined)
              if (from === undefined || from === index() || fixed(id)) return
              props.onChange(moveTo(props.items, from, index()))
            }}
            onDragEnd={() => setDragging(undefined)}
          >
            <span data-slot="operator-layer-open">
              <Show when={!fixed(id)}>
                <Icon name="chevron-grabber-vertical" />
              </Show>
              <span data-slot="operator-layer-name">{props.name(id)}</span>
              {props.badge?.(id)}
              <Show when={props.locked?.(id)}>
                <Tag>{language.t("operator.profile.locked")}</Tag>
              </Show>
              <Show when={props.required?.(id)}>
                <Tag>{language.t("operator.profile.required")}</Tag>
              </Show>
            </span>
            <Show when={!fixed(id)}>
              <IconButtonV2
                variant="ghost-muted"
                size="small"
                aria-label={language.t("operator.profile.up", { name: props.name(id) })}
                icon={<Icon name="arrow-up" />}
                onClick={() => props.onChange(move(props.items, index(), -1))}
              />
              <IconButtonV2
                variant="ghost-muted"
                size="small"
                aria-label={language.t("operator.profile.down", { name: props.name(id) })}
                icon={<Icon name="chevron-down" />}
                onClick={() => props.onChange(move(props.items, index(), 1))}
              />
              <Show when={!props.required?.(id)}>
                <IconButtonV2
                  variant="ghost-muted"
                  size="small"
                  aria-label={language.t("operator.profile.removeFrom", { name: props.name(id) })}
                  icon={<Icon name="close-small" />}
                  onClick={() => props.onChange(props.items.filter((item) => item !== id))}
                />
              </Show>
            </Show>
          </li>
        )}
      </For>
    </ol>
  )
}
