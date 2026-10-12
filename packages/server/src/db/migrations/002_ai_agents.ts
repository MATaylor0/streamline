import type { Kysely } from 'kysely';

/**
 * AI agent registry and delegation. Agents are catalog entries (like business
 * systems); process steps, or whole processes, record which agent they are
 * delegated to, at what level of automation, and how humans oversee it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('agents')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull().unique())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('provider', 'text')
    .addColumn('model', 'text')
    .addColumn('platform', 'text')
    .addColumn('owner_team_id', 'text', (c) => c.references('teams.id').onDelete('set null'))
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('proposed'))
    .addColumn('risk_tier', 'text', (c) => c.notNull().defaultTo('limited'))
    .addColumn('data_access', 'text')
    .addColumn('service_account_id', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('documentation_url', 'text')
    .addColumn('next_review_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('agent_systems')
    .addColumn('agent_id', 'text', (c) => c.notNull().references('agents.id').onDelete('cascade'))
    .addColumn('system_id', 'text', (c) => c.notNull().references('systems.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('agent_systems_pk', ['agent_id', 'system_id'])
    .execute();

  for (const table of ['nodes', 'processes']) {
    await db.schema.alterTable(table).addColumn('agent_id', 'text', (c) => c.references('agents.id').onDelete('set null')).execute();
    await db.schema.alterTable(table).addColumn('automation_level', 'text', (c) => c.notNull().defaultTo('manual')).execute();
    await db.schema.alterTable(table).addColumn('oversight', 'text').execute();
  }
  await db.schema.createIndex('nodes_agent_idx').on('nodes').column('agent_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('nodes_agent_idx').ifExists().execute();
  for (const table of ['nodes', 'processes']) {
    for (const col of ['oversight', 'automation_level', 'agent_id']) await db.schema.alterTable(table).dropColumn(col).execute();
  }
  await db.schema.dropTable('agent_systems').ifExists().execute();
  await db.schema.dropTable('agents').ifExists().execute();
}
