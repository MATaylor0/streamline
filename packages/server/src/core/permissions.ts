/**
 * Role-based access control. Every operation declares the single permission it
 * needs; roles are bundles of permissions. The same table is enforced for the
 * UI, REST API, MCP tools and CLI because they all go through the executor.
 */

export const PERMISSIONS = {
  'process:read': 'View processes, diagrams, versions and comments',
  'process:write': 'Create and edit processes and their diagrams',
  'process:publish': 'Approve, publish and archive processes',
  'process:delete': 'Permanently delete processes',
  'catalog:read': 'View teams, systems, risks, controls and tags',
  'catalog:write': 'Manage teams, systems, risks, controls and tags',
  'comment:write': 'Add and resolve comments',
  'analytics:read': 'View dashboards, reports and team interaction maps',
  'data:export': 'Export data in bulk',
  'data:import': 'Import data in bulk',
  'self:manage': 'Manage own profile, password and API tokens',
  'admin:users': 'Manage users, service accounts and roles',
  'admin:settings': 'Manage organisation-wide settings and webhooks',
  'admin:audit': 'View the audit log',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ROLES = ['viewer', 'editor', 'approver', 'admin'] as const;
export type Role = (typeof ROLES)[number];

const viewer: Permission[] = ['process:read', 'catalog:read', 'comment:write', 'analytics:read', 'data:export', 'self:manage'];
const editor: Permission[] = [...viewer, 'process:write', 'catalog:write'];
const approver: Permission[] = [...editor, 'process:publish'];
const admin: Permission[] = Object.keys(PERMISSIONS) as Permission[];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(viewer),
  editor: new Set(editor),
  approver: new Set(approver),
  admin: new Set(admin),
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Read-only access to processes, catalog and reports; can comment.',
  editor: 'Can create and edit processes and catalog entries.',
  approver: 'Editor who can also approve, publish and archive processes.',
  admin: 'Full access including users, settings, audit log and deletion.',
};

/** Permissions that a read-only API token may still exercise. */
export const READ_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'process:read',
  'catalog:read',
  'analytics:read',
  'data:export',
  'admin:audit',
]);

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
