export interface Ref {
  id: string;
  name: string;
  color?: string;
}

export interface Me {
  id: string | null;
  email: string;
  name: string;
  role: 'viewer' | 'editor' | 'approver' | 'admin';
  kind: string;
  permissions: string[];
  teams: Array<{ id: string; name: string; role: string }>;
  tokenScope: string | null;
  organizationName: string;
}

export interface AuthConfig {
  organizationName: string;
  loginBanner: string;
  localEnabled: boolean;
  oidc: { enabled: boolean; displayName?: string; startUrl?: string };
  version: string;
}

export type ProcessStatus = 'draft' | 'in_review' | 'published' | 'archived';

export interface Process {
  id: string;
  ref: string;
  name: string;
  summary: string;
  description: string;
  status: ProcessStatus;
  category: string | null;
  ownerTeam: Ref | null;
  ownerUser: { id: string; name: string; email: string } | null;
  tags: Array<{ id: string; name: string; color: string }>;
  reviewIntervalDays: number | null;
  nextReviewAt: string | null;
  revision: number;
  publishedVersion: number | null;
  submittedBy: string | null;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
}

export type NodeType = 'start' | 'end' | 'task' | 'decision' | 'subprocess' | 'event' | 'document' | 'system' | 'note';

export interface StepNode {
  id: string;
  processId: string;
  type: NodeType;
  label: string;
  description: string;
  teamId: string | null;
  actorRole: string | null;
  durationMinutes: number | null;
  inputs: string | null;
  outputs: string | null;
  linkedProcessId: string | null;
  position: { x: number; y: number };
  systemIds: string[];
  riskIds: string[];
  controlIds: string[];
}

export interface Flow {
  id: string;
  source: string;
  target: string;
  label: string | null;
}

export interface ProcessFull extends Process {
  nodes: StepNode[];
  edges: Flow[];
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  department: string | null;
  color: string;
  memberCount: number;
  ownedProcessCount: number;
  stepCount: number;
  involvedProcessCount: number;
}

export interface System {
  id: string;
  name: string;
  description: string;
  vendor: string | null;
  category: string | null;
  criticality: 'low' | 'medium' | 'high' | 'critical';
  ownerTeam: Ref | null;
  url: string | null;
  processCount: number;
  stepCount: number;
}

export interface Risk {
  id: string;
  ref: string;
  title: string;
  description: string;
  category: string | null;
  likelihood: number;
  impact: number;
  score: number;
  rating: 'low' | 'medium' | 'high' | 'critical';
  status: string;
  ownerTeam: Ref | null;
  controls: Array<{ id: string; ref: string; name: string; effectiveness: string }>;
  controlIds: string[];
  processCount: number;
  stepCount: number;
}

export interface Control {
  id: string;
  ref: string;
  name: string;
  description: string;
  controlType: string;
  nature: string;
  frequency: string | null;
  effectiveness: string;
  ownerTeam: Ref | null;
  risks: Array<{ id: string; ref: string; title: string }>;
  riskIds: string[];
  processCount: number;
  stepCount: number;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  processCount: number;
}

export interface UsedIn {
  id: string;
  ref: string;
  name: string;
  status: string;
  steps: Array<{ id: string; label: string }>;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  kind: string;
  status: string;
  authProvider?: string;
  lastLoginAt?: string | null;
  lockedUntil?: string | null;
  teams: Array<{ id: string; name: string; role: string }>;
}

export interface Settings {
  organizationName: string;
  enforceTeamOwnership: boolean;
  requireReview: boolean;
  allowSelfApproval: boolean;
  defaultReviewIntervalDays: number;
  processRefPrefix: string;
  loginBanner: string;
}
