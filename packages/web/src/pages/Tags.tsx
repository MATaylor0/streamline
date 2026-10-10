import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Content } from '../components/Layout';
import { Confirm, Empty, Loading, PageHeader } from '../components/ui';
import { EntityForm } from '../components/EntityForm';
import { IconPlus } from '../components/icons';
import { useAction, useOp } from '../hooks';
import { useAuth } from '../auth';
import type { Tag } from '../types';

export function TagsPage() {
  const { can } = useAuth();
  const { data, isLoading } = useOp<Tag[]>('tag.list', {});
  const [editing, setEditing] = useState<Tag | 'new' | null>(null);
  const del = useAction('tag.delete', { toast: 'Tag deleted' });
  return (
    <Content>
      <PageHeader
        title="Tags"
        subtitle="Free-form labels for grouping processes (e.g. regulation, programme, region)."
        actions={
          can('catalog:write') && (
            <button className="btn primary" onClick={() => setEditing('new')}>
              <IconPlus /> New tag
            </button>
          )
        }
      />
      <div className="card" style={{ maxWidth: 720 }}>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty title="No tags yet">Tags are created automatically when you add them to a process.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Tag</th>
                <th>Processes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/processes?tag=${encodeURIComponent(t.name)}`} className="tag" style={{ color: 'inherit' }}>
                      <span className="dot" style={{ background: t.color }} />
                      {t.name}
                    </Link>
                  </td>
                  <td>{t.processCount}</td>
                  <td style={{ textAlign: 'right' }}>
                    {can('catalog:write') && (
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn sm" onClick={() => setEditing(t)}>
                          Edit
                        </button>
                        <Confirm label="Delete" message={`Delete tag "${t.name}"? It will be removed from ${t.processCount} process(es).`} onConfirm={() => del.mutate({ id: t.id })} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <EntityForm
          title={editing === 'new' ? 'New tag' : 'Edit tag'}
          op={editing === 'new' ? 'tag.create' : 'tag.update'}
          extra={editing === 'new' ? undefined : { id: editing.id }}
          fields={[
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'color', label: 'Colour', type: 'color' },
          ]}
          initial={editing === 'new' ? { color: '#2563eb' } : { name: editing.name, color: editing.color }}
          onClose={() => setEditing(null)}
        />
      )}
    </Content>
  );
}
