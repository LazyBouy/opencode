import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003101527_session_merge_binding",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_merge_binding\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`adapter\` text NOT NULL,
          \`transport\` text NOT NULL,
          \`external_session_id\` text,
          \`cwd\` text NOT NULL,
          \`status\` text NOT NULL,
          \`args\` text NOT NULL,
          \`parent_model\` text,
          \`process_pid\` integer,
          \`error\` text,
          \`time_last_event\` integer,
          \`time_detached\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_merge_binding_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_merge_binding_session_status_idx\` ON \`session_merge_binding\` (\`session_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_merge_binding_external_idx\` ON \`session_merge_binding\` (\`adapter\`,\`external_session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
