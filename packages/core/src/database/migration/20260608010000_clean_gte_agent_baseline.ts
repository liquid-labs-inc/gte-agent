import type { DatabaseMigration } from "../migration"
import { Effect } from "effect"

export default {
  id: "20260608010000_clean_gte_agent_baseline",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          \`time_updated\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        )
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text NOT NULL,
          \`time_created\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          PRIMARY KEY(\`project_id\`, \`directory\`),
          FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY NOT NULL,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        )
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`, \`seq\`)`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`, \`type\`, \`seq\`)`)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`project_id\` text NOT NULL,
          \`principal_id\` text NOT NULL DEFAULT 'dev_principal',
          \`authority_id\` text NOT NULL DEFAULT 'dev_authority',
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real NOT NULL DEFAULT 0,
          \`tokens_input\` integer NOT NULL DEFAULT 0,
          \`tokens_output\` integer NOT NULL DEFAULT 0,
          \`tokens_reasoning\` integer NOT NULL DEFAULT 0,
          \`tokens_cache_read\` integer NOT NULL DEFAULT 0,
          \`tokens_cache_write\` integer NOT NULL DEFAULT 0,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`selected_market\` text,
          \`tracked_address\` text,
          \`pinned_panels\` text,
          \`time_created\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          \`time_updated\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          \`time_compacting\` integer,
          \`time_archived\` integer,
          FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`)`)
      yield* tx.run(`CREATE INDEX \`session_principal_idx\` ON \`session\` (\`principal_id\`)`)
      yield* tx.run(`CREATE INDEX \`session_authority_idx\` ON \`session\` (\`authority_id\`)`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`)`)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          \`time_updated\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          \`data\` text NOT NULL,
          FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        )
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`, \`seq\`)`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`, \`type\`, \`seq\`)`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`, \`time_created\`, \`id\`)`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`)`)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        )
      `)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`, \`promoted_seq\`, \`delivery\`, \`admitted_seq\`)`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`, \`admitted_seq\`)`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`, \`promoted_seq\`)`,
      )
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY NOT NULL,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          \`replacement_seq\` integer,
          \`revision\` integer NOT NULL DEFAULT 0,
          FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          \`time_updated\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        )
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`, \`action\`, \`resource\`)`,
      )
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          \`time_updated\` integer NOT NULL DEFAULT (unixepoch() * 1000),
          PRIMARY KEY(\`session_id\`, \`position\`),
          FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`)`)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY NOT NULL,
          \`time_completed\` integer NOT NULL
        )
      `)
    })
  },
} satisfies DatabaseMigration.Migration
