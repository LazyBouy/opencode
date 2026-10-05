import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { For } from "solid-js"
import { useLanguage } from "@/context/language"
import type { Column } from "./data-table"

// Menu of checkboxes that adds or removes a table's optional columns. Required columns are not
// listed: they always show.
export function ColumnPicker<T>(props: {
  label: string
  columns: readonly Column<T>[]
  visible: (column: Column<T>) => boolean
  onChange: (id: string, visible: boolean) => void
}) {
  const language = useLanguage()
  return (
    <MenuV2 gutter={6} modal={false} placement="bottom-end">
      <MenuV2.Trigger
        as={IconButtonV2}
        variant="ghost-muted"
        size="small"
        icon={<Icon name="sliders" />}
        aria-label={language.t("operator.table.columnsOf", { table: props.label })}
      />
      <MenuV2.Portal>
        <MenuV2.Content>
          <MenuV2.Group>
            <MenuV2.GroupLabel>{language.t("operator.table.optionalColumns")}</MenuV2.GroupLabel>
            <For each={props.columns.filter((column) => column.optional)}>
              {(column) => (
                <MenuV2.CheckboxItem
                  checked={props.visible(column)}
                  closeOnSelect={false}
                  onChange={(checked: boolean) => props.onChange(column.id, checked)}
                >
                  {column.header}
                </MenuV2.CheckboxItem>
              )}
            </For>
          </MenuV2.Group>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
