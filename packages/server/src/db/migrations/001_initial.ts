import type { Kysely } from 'kysely';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('password_hash', 'text')
    .addColumn('role', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull().defaultTo('human'))
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
    .addColumn('auth_provider', 'text', (c) => c.notNull().defaultTo('local'))
    .addColumn('external_id', 'text')
    .addColumn('failed_logins', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('locked_until', 'text')
    .addColumn('last_login_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('csrf_token', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('last_seen_at', 'text', (c) => c.notNull())
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .execute();
  await db.schema.createIndex('sessions_user_idx').on('sessions').column('user_id').execute();

  await db.schema
    .createTable('api_tokens')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('prefix', 'text', (c) => c.notNull())
    .addColumn('scope', 'text', (c) => c.notNull().defaultTo('write'))
    .addColumn('expires_at', 'text')
    .addColumn('last_used_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('revoked_at', 'text')
    .execute();
  await db.schema.createIndex('api_tokens_user_idx').on('api_tokens').column('user_id').execute();

  await db.schema
    .createTable('teams')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull().unique())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('department', 'text')
    .addColumn('color', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('team_members')
    .addColumn('team_id', 'text', (c) => c.notNull().references('teams.id').onDelete('cascade'))
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('role', 'text', (c) => c.notNull().defaultTo('member'))
    .addPrimaryKeyConstraint('team_members_pk', ['team_id', 'user_id'])
    .execute();
  await db.schema.createIndex('team_members_user_idx').on('team_members').column('user_id').execute();

  await db.schema
    .createTable('processes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('ref', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('summary', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('draft'))
    .addColumn('category', 'text')
    .addColumn('owner_team_id', 'text', (c) => c.references('teams.id').onDelete('set null'))
    .addColumn('owner_user_id', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('review_interval_days', 'integer')
    .addColumn('next_review_at', 'text')
    .addColumn('revision', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('published_version', 'integer')
    .addColumn('submitted_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('submitted_at', 'text')
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('updated_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('processes_owner_team_idx').on('processes').column('owner_team_id').execute();
  await db.schema.createIndex('processes_status_idx').on('processes').column('status').execute();

  await db.schema
    .createTable('tags')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull().unique())
    .addColumn('color', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('process_tags')
    .addColumn('process_id', 'text', (c) => c.notNull().references('processes.id').onDelete('cascade'))
    .addColumn('tag_id', 'text', (c) => c.notNull().references('tags.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('process_tags_pk', ['process_id', 'tag_id'])
    .execute();
  await db.schema.createIndex('process_tags_tag_idx').on('process_tags').column('tag_id').execute();

  await db.schema
    .createTable('nodes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('process_id', 'text', (c) => c.notNull().references('processes.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('team_id', 'text', (c) => c.references('teams.id').onDelete('set null'))
    .addColumn('actor_role', 'text')
    .addColumn('duration_minutes', 'integer')
    .addColumn('inputs', 'text')
    .addColumn('outputs', 'text')
    .addColumn('linked_process_id', 'text', (c) => c.references('processes.id').onDelete('set null'))
    .addColumn('x', 'double precision', (c) => c.notNull().defaultTo(0))
    .addColumn('y', 'double precision', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('nodes_process_idx').on('nodes').column('process_id').execute();
  await db.schema.createIndex('nodes_team_idx').on('nodes').column('team_id').execute();

  await db.schema
    .createTable('edges')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('process_id', 'text', (c) => c.notNull().references('processes.id').onDelete('cascade'))
    .addColumn('source_node_id', 'text', (c) => c.notNull().references('nodes.id').onDelete('cascade'))
    .addColumn('target_node_id', 'text', (c) => c.notNull().references('nodes.id').onDelete('cascade'))
    .addColumn('label', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('edges_process_idx').on('edges').column('process_id').execute();

  await db.schema
    .createTable('systems')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull().unique())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('vendor', 'text')
    .addColumn('category', 'text')
    .addColumn('criticality', 'text', (c) => c.notNull().defaultTo('medium'))
    .addColumn('owner_team_id', 'text', (c) => c.references('teams.id').onDelete('set null'))
    .addColumn('url', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('risks')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('ref', 'text', (c) => c.notNull().unique())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('category', 'text')
    .addColumn('likelihood', 'integer', (c) => c.notNull().defaultTo(3))
    .addColumn('impact', 'integer', (c) => c.notNull().defaultTo(3))
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('open'))
    .addColumn('owner_team_id', 'text', (c) => c.references('teams.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('controls')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('ref', 'text', (c) => c.notNull().unique())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('control_type', 'text', (c) => c.notNull().defaultTo('preventive'))
    .addColumn('nature', 'text', (c) => c.notNull().defaultTo('manual'))
    .addColumn('frequency', 'text')
    .addColumn('effectiveness', 'text', (c) => c.notNull().defaultTo('not_tested'))
    .addColumn('owner_team_id', 'text', (c) => c.references('teams.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  const linkTables: Array<[string, string]> = [
    ['node_systems', 'systems'],
    ['node_risks', 'risks'],
    ['node_controls', 'controls'],
  ];
  for (const [table, target] of linkTables) {
    await db.schema
      .createTable(table)
      .addColumn('node_id', 'text', (c) => c.notNull().references('nodes.id').onDelete('cascade'))
      .addColumn('target_id', 'text', (c) => c.notNull().references(`${target}.id`).onDelete('cascade'))
      .addPrimaryKeyConstraint(`${table}_pk`, ['node_id', 'target_id'])
      .execute();
    await db.schema.createIndex(`${table}_target_idx`).on(table).column('target_id').execute();
  }

  await db.schema
    .createTable('risk_controls')
    .addColumn('risk_id', 'text', (c) => c.notNull().references('risks.id').onDelete('cascade'))
    .addColumn('control_id', 'text', (c) => c.notNull().references('controls.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('risk_controls_pk', ['risk_id', 'control_id'])
    .execute();

  await db.schema
    .createTable('process_versions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('process_id', 'text', (c) => c.notNull().references('processes.id').onDelete('cascade'))
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('snapshot', 'text', (c) => c.notNull())
    .addColumn('change_note', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('published_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('published_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('process_versions_unique', ['process_id', 'version'])
    .execute();

  await db.schema
    .createTable('comments')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('process_id', 'text', (c) => c.notNull().references('processes.id').onDelete('cascade'))
    .addColumn('node_id', 'text', (c) => c.references('nodes.id').onDelete('set null'))
    .addColumn('author_id', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('body', 'text', (c) => c.notNull())
    .addColumn('resolved', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('comments_process_idx').on('comments').column('process_id').execute();

  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('at', 'text', (c) => c.notNull())
    .addColumn('actor_id', 'text')
    .addColumn('actor_label', 'text', (c) => c.notNull())
    .addColumn('channel', 'text', (c) => c.notNull())
    .addColumn('operation', 'text', (c) => c.notNull())
    .addColumn('target_type', 'text')
    .addColumn('target_id', 'text')
    .addColumn('outcome', 'text', (c) => c.notNull())
    .addColumn('detail', 'text')
    .addColumn('ip', 'text')
    .addColumn('request_id', 'text')
    .execute();
  await db.schema.createIndex('audit_log_at_idx').on('audit_log').column('at').execute();
  await db.schema.createIndex('audit_log_target_idx').on('audit_log').columns(['target_type', 'target_id']).execute();

  await db.schema
    .createTable('settings')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('webhooks')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('secret', 'text', (c) => c.notNull())
    .addColumn('events', 'text', (c) => c.notNull())
    .addColumn('active', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('last_status', 'text')
    .addColumn('last_delivery_at', 'text')
    .addColumn('failure_count', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();

  await db.schema
    .createTable('counters')
    .addColumn('name', 'text', (c) => c.primaryKey())
    .addColumn('value', 'integer', (c) => c.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const tables = [
    'counters',
    'webhooks',
    'settings',
    'audit_log',
    'comments',
    'process_versions',
    'risk_controls',
    'node_controls',
    'node_risks',
    'node_systems',
    'controls',
    'risks',
    'systems',
    'edges',
    'nodes',
    'process_tags',
    'tags',
    'processes',
    'team_members',
    'teams',
    'api_tokens',
    'sessions',
    'users',
  ];
  for (const t of tables) await db.schema.dropTable(t).ifExists().execute();
}
