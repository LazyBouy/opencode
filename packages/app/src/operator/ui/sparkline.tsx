import { sparklinePoints } from "./chart"

export function Sparkline(props: { values: readonly number[]; label: string; width?: number; height?: number }) {
  const width = () => props.width ?? 120
  const height = () => props.height ?? 28
  return (
    <svg
      data-component="operator-sparkline"
      role="img"
      aria-label={props.label}
      width={width()}
      height={height()}
      viewBox={`0 0 ${width()} ${height()}`}
    >
      <polyline points={sparklinePoints(props.values, width(), height(), 2)} fill="none" stroke="currentColor" />
    </svg>
  )
}
