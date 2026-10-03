import { describe, expect, test } from "bun:test"
import { contrastRatio } from "./color"
import { resolveTheme } from "./resolve"
import iphi from "./themes/iphi.json"
import type { DesktopTheme, HexColor } from "./types"
import { resolveThemeV2 } from "./v2/resolve"

const theme = iphi as DesktopTheme

const hex = (tokens: Record<string, string>, name: string): HexColor => {
  const value = tokens[name]
  if (!value?.startsWith("#")) throw new Error(`${name} is not a literal hex color: ${value}`)
  return value.slice(0, 7) as HexColor
}

// Literal grey-ramp colors the iphi theme pins for each mode, used to resolve `var(--v2-grey-*)` refs.
const grey = (variant: "light" | "dark", step: number) =>
  theme[variant].v2Overrides?.[`v2-grey-${step}`]?.slice(0, 7) as HexColor

describe("iphi theme", () => {
  test("resolves both variants", () => {
    const v1 = resolveTheme(theme)
    const v2 = resolveThemeV2(theme)
    for (const variant of ["light", "dark"] as const) {
      expect(Object.keys(v1[variant]).length).toBeGreaterThan(100)
      expect(Object.keys(v2[variant]).length).toBeGreaterThan(100)
    }
  })

  test("desktop window backgrounds are opaque six-digit hex", () => {
    const v1 = resolveTheme(theme)
    expect(v1.light["background-base"]).toMatch(/^#[0-9A-F]{6}$/i)
    expect(v1.dark["background-base"]).toMatch(/^#[0-9A-F]{6}$/i)
  })

  test("orange is the accent and info keeps iphi's blue", () => {
    const v2 = resolveThemeV2(theme)
    expect(v2.light["v2-background-bg-accent"]).toBe("#FF6600")
    expect(v2.light["v2-border-border-focus"]).toBe("#FF6600")
    expect(v2.light["v2-state-fg-info"]).toBe("#007BFF")
    expect(v2.dark["v2-state-fg-info"]).toBe("#74B4FA")
  })

  test.each(["light", "dark"] as const)("%s text meets WCAG contrast on the base background", (variant) => {
    const v2 = resolveThemeV2(theme)[variant]
    const background = variant === "light" ? grey("light", 100) : grey("dark", 1000)
    expect(contrastRatio(hex(v2, "v2-text-text-base"), background)).toBeGreaterThanOrEqual(7)
    expect(contrastRatio(hex(v2, "v2-text-text-muted"), background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(hex(v2, "v2-text-text-accent"), background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(hex(v2, "v2-state-fg-info"), background)).toBeGreaterThanOrEqual(3)
  })
})
