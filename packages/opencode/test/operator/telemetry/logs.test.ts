import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { OperatorTelemetryLogs } from "@/operator/telemetry/logs"
import { tmpdir } from "../../fixture/fixture"

// observability_spec.md §5.8, §21.1: levels, cutting, file truncation and a new inode, session links.

const line = (level: string, message: string, fields = "") =>
  `timestamp=2026-10-16T09:10:27.513Z level=${level} run=e51adf77 message=${JSON.stringify(message)}${fields ? ` ${fields}` : ""}\n`

describe("telemetry log tail", () => {
  test("a line's fields, unquoted, with its session; long values are cut", () => {
    const entry = OperatorTelemetryLogs.parse(
      line(
        "ERROR",
        "stream error",
        `service=llm session.id=ses_1 error.message="bad \\"gateway\\"" big=${"x".repeat(900)}`,
      ).trim(),
      "log:1:0",
    )!
    expect(entry).toMatchObject({
      id: "log:1:0",
      time_ms: Date.parse("2026-10-16T09:10:27.513Z"),
      level: "ERROR",
      message: "stream error",
      run: "e51adf77",
      service: "llm",
      session_id: "ses_1",
    })
    const fields = JSON.parse(entry.fields!)
    expect(fields["error.message"]).toBe('bad "gateway"')
    expect(fields.big).toHaveLength(500)
    expect(OperatorTelemetryLogs.parse(line("WARN", "y".repeat(1500)).trim(), "x")!.message).toHaveLength(1000)
    expect(OperatorTelemetryLogs.parse("not a log line", "x")).toBeUndefined()
  })

  test("a first start begins at the end; new lines at or above the level are read; a partial line waits", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.log")
    await fs.writeFile(file, line("ERROR", "before start"))
    const first = await OperatorTelemetryLogs.read({ file, position: undefined, level: "warn" })
    expect(first.entries).toEqual([])
    await fs.appendFile(
      file,
      line("INFO", "info") + line("WARN", "warned") + line("ERROR", "failed") + "timestamp=2026",
    )
    const second = await OperatorTelemetryLogs.read({ file, position: first.position, level: "warn" })
    expect(second.entries.map((entry) => entry.message)).toEqual(["warned", "failed"])
    // Errors only.
    expect(
      (await OperatorTelemetryLogs.read({ file, position: first.position, level: "error" })).entries.map(
        (e) => e.message,
      ),
    ).toEqual(["failed"])
    // The partial line is read once it ends.
    await fs.appendFile(file, `-10-16T09:10:28.000Z level=WARN run=r message=later\n`)
    const third = await OperatorTelemetryLogs.read({ file, position: second.position, level: "warn" })
    expect(third.entries.map((entry) => entry.message)).toEqual(["later"])
    // Ids are the file and the line's offset, so reading again is the same rows.
    expect(second.entries[0]!.id).toMatch(/^log:\d+:\d+$/)
  })

  test("a file that got smaller or was replaced is read again from the start", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.log")
    await fs.writeFile(file, line("WARN", "one") + line("WARN", "two") + line("WARN", "three"))
    const start = await OperatorTelemetryLogs.read({ file, position: undefined, level: "warn" })
    await fs.writeFile(file, line("WARN", "short"))
    const truncated = await OperatorTelemetryLogs.read({ file, position: start.position, level: "warn" })
    expect(truncated.entries.map((entry) => entry.message)).toEqual(["short"])
    // A new file in its place (a new inode: written beside it, then renamed over it).
    await fs.writeFile(
      `${file}.new`,
      line("ERROR", "new file") + line("ERROR", "and more lines to be longer than before"),
    )
    await fs.rename(`${file}.new`, file)
    const replaced = await OperatorTelemetryLogs.read({ file, position: truncated.position, level: "warn" })
    expect(replaced.entries.map((entry) => entry.message)).toEqual([
      "new file",
      "and more lines to be longer than before",
    ])
  })

  test("a backfill reads the end of the file, skipping the cut first line", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.log")
    await fs.writeFile(file, line("WARN", "old ".repeat(50)) + line("WARN", "recent"))
    const found = await OperatorTelemetryLogs.read({ file, position: undefined, level: "warn", fromStart: 120 })
    expect(found.entries.map((entry) => entry.message)).toEqual(["recent"])
  })
})
