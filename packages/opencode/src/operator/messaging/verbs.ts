export * as OperatorPingVerbs from "./verbs"

// The `ping` verbs only a project's manager is offered (SPEC-0023 §8.3), shared by the tool's definition (seams.ts)
// and what the calls do (ping.ts).
export const MANAGER = ["forward", "drop", "rule"] as const
