export * as OperatorFolderSql from "./folder-sql"

import { eq, or, sql, type SQL } from "drizzle-orm"
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"

// A folder column that is `root` or a folder inside it. Compared by prefix, not LIKE: a folder name
// can hold `_` or `%`, which LIKE would read as wildcards.
export function within(column: SQLiteColumn, root: string): SQL {
  const prefix = `${root.replace(/\/+$/, "")}/`
  return or(eq(column, root), sql`substr(${column}, 1, ${prefix.length}) = ${prefix}`)!
}
