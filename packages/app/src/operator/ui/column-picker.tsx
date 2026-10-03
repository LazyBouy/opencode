import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { For } from "solid-js"
import { useLanguage } from "@/context/language"
import type { Column } from "./data-table"

// Menu of checkboxes that shows or hides DataTable columns. The caller keeps the hidden list,
// usually in persisted storage so the choice survives reloads.
export function ColumnPicker<T>(props: {
  columns: readonly Column<T>[]
  hidden: readonly string[]
  onChange: (hidden: string[]) => void
}) {
  const language = useLanguage()
  return (
    <MenuV2 gutter={6} modal={false} placement="bottom-end">
      <MenuV2.Trigger as={ButtonV2} size="small" variant="ghost">
        {language.t("operator.table.columns")}
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content>
          <For each={props.columns}>
            {(column) => (
              <MenuV2.CheckboxItem
                checked={!props.hidden.includes(column.id)}
                closeOnSelect={false}
                onChange={(checked: boolean) =>
                  props.onChange(checked ? props.hidden.filter((id) => id !== column.id) : [...props.hidden, column.id])
                }
              >
                {column.header}
              </MenuV2.CheckboxItem>
            )}
          </For>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
