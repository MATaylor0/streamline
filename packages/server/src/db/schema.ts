import type { Generated, Insertable, Kysely, Selectable, Transaction, Updateable } from 'kysely';

/**
 * Database schema. Column types are deliberately portable between PostgreSQL
 * and SQLite: ids and timestamps are text (UUIDs / ISO-8601), booleans are
 * integers (0/1) and structured values are JSON text.
 */

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role: string;
  kind: string; // 'human' | 'service'
  status: string; // 'active' | 'disabled'
  auth_provider: string; // 'local' | 'oidc'
  external_id: string | null;
  failed_logins: Generated<number>;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionsTable {
  id: string;
  token_hash: string;
  user_id: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
}

export interface ApiTokensTable {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  scope: string; // 'read' | 'write'
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface TeamsTable {
  id: string;
  name: string;
  description: string;
  department: string | null;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface TeamMembersTable {
  team_id: string;
  user_id: string;
  role: string; // 'member' | 'lead'
}

export interface ProcessesTable {
  id: string;
  ref: string;
  name: string;
  summary: string;
  description: string;
  status: string; // draft | in_review | published | archived
  category: string | null;
  owner_team_id: string | null;
  owner_user_id: string | null;
  review_interval_days: number | null;
  next_review_at: string | null;
  revision: number;
  published_version: number | null;
  submitted_by: string | null;
  submitted_at: string | null;
  agent_id: Generated<string | null>;
  automation_level: Generated<string>; // manual | assisted | supervised | autonomous
  oversight: Generated<string | null>;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TagsTable {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface ProcessTagsTable {
  process_id: string;
  tag_id: string;
}

export interface NodesTable {
  id: string;
  process_id: string;
  type: string;
  label: string;
  description: string;
  team_id: string | null;
  actor_role: string | null;
  duration_minutes: number | null;
  inputs: string | null;
  outputs: string | null;
  linked_process_id: string | null;
  agent_id: Generated<string | null>;
  automation_level: Generated<string>; // manual | assisted | supervised | autonomous
  oversight: Generated<string | null>;
  x: number;
  y: number;
  created_at: string;
  updated_at: string;
}

export interface EdgesTable {
  id: string;
  process_id: string;
  source_node_id: string;
  target_node_id: string;
  label: string | null;
  created_at: string;
}

export interface SystemsTable {
  id: string;
  name: string;
  description: string;
  vendor: string | null;
  category: string | null;
  criticality: string; // low | medium | high | critical
  owner_team_id: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
}

export interface RisksTable {
  id: string;
  ref: string;
  title: string;
  description: string;
  category: string | null;
  likelihood: number; // 1-5
  impact: number; // 1-5
  status: string; // open | mitigated | accepted | closed
  owner_team_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ControlsTable {
  id: string;
  ref: string;
  name: string;
  description: string;
  control_type: string; // preventive | detective | corrective
  nature: string; // manual | automated | it_dependent
  frequency: string | null;
  effectiveness: string; // not_tested | effective | partially_effective | ineffective
  owner_team_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentsTable {
  id: string;
  name: string;
  description: string;
  provider: string | null;
  model: string | null;
  platform: string | null;
  owner_team_id: string | null;
  status: string; // proposed | pilot | production | suspended | retired
  risk_tier: string; // minimal | limited | high
  data_access: string | null;
  service_account_id: string | null;
  documentation_url: string | null;
  next_review_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentSystemsTable {
  agent_id: string;
  system_id: string;
}

export interface NodeLinksTable {
  node_id: string;
  target_id: string;
}

export interface RiskControlsTable {
  risk_id: string;
  control_id: string;
}

export interface ProcessVersionsTable {
  id: string;
  process_id: string;
  version: number;
  snapshot: string;
  change_note: string;
  published_by: string | null;
  published_at: string;
}

export interface CommentsTable {
  id: string;
  process_id: string;
  node_id: string | null;
  author_id: string | null;
  body: string;
  resolved: number;
  created_at: string;
  updated_at: string;
}

export interface AuditLogTable {
  id: string;
  at: string;
  actor_id: string | null;
  actor_label: string;
  channel: string;
  operation: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string; // success | denied | error
  detail: string | null;
  ip: string | null;
  request_id: string | null;
}

export interface SettingsTable {
  key: string;
  value: string;
  updated_at: string;
}

export interface WebhooksTable {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string;
  active: number;
  created_by: string | null;
  created_at: string;
  last_status: string | null;
  last_delivery_at: string | null;
  failure_count: number;
}

export interface CountersTable {
  name: string;
  value: number;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  api_tokens: ApiTokensTable;
  teams: TeamsTable;
  team_members: TeamMembersTable;
  processes: ProcessesTable;
  tags: TagsTable;
  process_tags: ProcessTagsTable;
  nodes: NodesTable;
  edges: EdgesTable;
  systems: SystemsTable;
  risks: RisksTable;
  controls: ControlsTable;
  agents: AgentsTable;
  agent_systems: AgentSystemsTable;
  node_systems: NodeLinksTable;
  node_risks: NodeLinksTable;
  node_controls: NodeLinksTable;
  risk_controls: RiskControlsTable;
  process_versions: ProcessVersionsTable;
  comments: CommentsTable;
  audit_log: AuditLogTable;
  settings: SettingsTable;
  webhooks: WebhooksTable;
  counters: CountersTable;
}

export type DB = Kysely<Database> | Transaction<Database>;

export type UserRow = Selectable<UsersTable>;
export type ProcessRow = Selectable<ProcessesTable>;
export type NodeRow = Selectable<NodesTable>;
export type EdgeRow = Selectable<EdgesTable>;
export type TeamRow = Selectable<TeamsTable>;
export type SystemRow = Selectable<SystemsTable>;
export type RiskRow = Selectable<RisksTable>;
export type ControlRow = Selectable<ControlsTable>;
export type AgentRow = Selectable<AgentsTable>;
export type NewNode = Insertable<NodesTable>;
export type ProcessUpdate = Updateable<ProcessesTable>;
