import { useMemo } from 'react';
import { useOp } from './hooks';
import type { Agent, Control, Page, Process, Risk, System, Tag, Team, User } from './types';
import type { Option } from './components/ui';

/** Shared lookups for pickers and labels (cached by react-query). */
export function useCatalog() {
  const teams = useOp<Team[]>('team.list', {}, { staleTime: 30_000 });
  const systems = useOp<System[]>('system.list', {}, { staleTime: 30_000 });
  const risks = useOp<Risk[]>('risk.list', {}, { staleTime: 30_000 });
  const controls = useOp<Control[]>('control.list', {}, { staleTime: 30_000 });
  const tags = useOp<Tag[]>('tag.list', {}, { staleTime: 30_000 });
  const processes = useOp<Page<Process>>('process.list', { limit: 500, sort: 'name', includeArchived: true }, { staleTime: 30_000 });
  const users = useOp<Page<User>>('user.list', { limit: 500, status: 'active' }, { staleTime: 60_000 });
  const agents = useOp<Agent[]>('agent.list', {}, { staleTime: 30_000 });

  return useMemo(() => {
    const t = teams.data ?? [];
    return {
      loading: teams.isLoading || systems.isLoading || risks.isLoading || controls.isLoading,
      teams: t,
      systems: systems.data ?? [],
      risks: risks.data ?? [],
      controls: controls.data ?? [],
      tags: tags.data ?? [],
      processes: processes.data?.items ?? [],
      users: users.data?.items ?? [],
      agents: agents.data ?? [],
      agentMap: new Map((agents.data ?? []).map((a) => [a.id, a])),
      agentOptions: (agents.data ?? []).filter((a) => a.status !== 'retired').map<Option>((a) => ({ value: a.id, label: a.name, hint: a.status })),
      teamMap: new Map(t.map((x) => [x.id, x])),
      teamOptions: t.map<Option>((x) => ({ value: x.id, label: x.name, hint: x.department ?? undefined, color: x.color })),
      systemOptions: (systems.data ?? []).map<Option>((x) => ({ value: x.id, label: x.name, hint: x.vendor ?? undefined })),
      riskOptions: (risks.data ?? []).map<Option>((x) => ({ value: x.id, label: x.title, hint: x.ref })),
      controlOptions: (controls.data ?? []).map<Option>((x) => ({ value: x.id, label: x.name, hint: x.ref })),
      userOptions: (users.data?.items ?? []).filter((u) => u.kind === 'human').map<Option>((u) => ({ value: u.id, label: u.name, hint: u.email })),
    };
  }, [teams.data, systems.data, risks.data, controls.data, tags.data, processes.data, users.data, agents.data, teams.isLoading, systems.isLoading, risks.isLoading, controls.isLoading]);
}
