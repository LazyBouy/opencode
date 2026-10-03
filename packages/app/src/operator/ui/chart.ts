// Geometry for the small SVG charts on operator pages; no chart library is needed for these.

// Points for a polyline that spans the box, scaled between the series' min and max (flat when constant).
export function sparklinePoints(values: readonly number[], width: number, height: number, inset = 1) {
  if (values.length === 0) return ""
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const step = values.length > 1 ? (width - inset * 2) / (values.length - 1) : 0
  return values
    .map((value, index) => {
      const x = inset + index * step
      const y = span === 0 ? height / 2 : inset + (1 - (value - min) / span) * (height - inset * 2)
      return `${round(x)},${round(y)}`
    })
    .join(" ")
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
