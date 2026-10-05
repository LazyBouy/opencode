import type { Component, JSX } from "solid-js"
import { FieldHelp } from "@/operator/ui/field-help"
import "../settings-v2.css"

export interface SettingsRowV2Props {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
  /** fork: names the field for the (i) when the title is not plain text. */
  field?: string
}

// fork: the description is the field helper's text, shown from the (i) beside the title.
export const SettingsRowV2: Component<SettingsRowV2Props> = (props) => {
  return (
    <div data-component="settings-v2-row">
      <div data-slot="settings-v2-row-copy">
        <div data-slot="settings-v2-row-title">
          {props.title}
          <FieldHelp
            field={props.field ?? (typeof props.title === "string" ? props.title : "")}
            text={props.description}
          />
        </div>
      </div>
      <div data-slot="settings-v2-row-control">{props.children}</div>
    </div>
  )
}
