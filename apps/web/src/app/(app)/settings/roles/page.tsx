'use client';

import { Lock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Empty, Field, Input, Notice, Panel, Select, Spinner } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useApi } from '@/lib/use-api';

interface RoleRow {
  id: string;
  name: string;
  key: string | null;
  dataScope: 'all' | 'team' | 'own';
  requiresOffice: boolean;
  isSystem: boolean;
  permissionCount: number;
  userCount: number;
}
interface RoleDetail extends RoleRow {
  permissions: string[];
}
interface Group {
  module: string;
  permissions: { code: string; description: string }[];
}

const SCOPE: Record<string, string> = { all: 'Everyone in the company', team: 'Their own team', own: 'Only their own records' };
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
const title = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function RoleEditor({ id, groups, onClose, onSaved }: { id: string | null; groups: Group[]; onClose: () => void; onSaved: () => void }) {
  const detail = useApi<RoleDetail>(id ? `/roles/${id}` : null);
  if (id && !detail.data) return <Modal title="Role" onClose={onClose}>{detail.error ? <Notice tone="bad">{detail.error.message}</Notice> : <Spinner />}</Modal>;
  return <RoleForm role={detail.data} groups={groups} onClose={onClose} onSaved={onSaved} />;
}

function RoleForm({ role, groups, onClose, onSaved }: { role?: RoleDetail | null; groups: Group[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(role?.name ?? '');
  const [scope, setScope] = useState<RoleRow['dataScope']>(role?.dataScope ?? 'own');
  const [office, setOffice] = useState(role?.requiresOffice ?? true);
  const [codes, setCodes] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (code: string, on: boolean) => setCodes((s) => { const n = new Set(s); if (on) n.add(code); else n.delete(code); return n; });
  const toggleGroup = (g: Group, on: boolean) => setCodes((s) => { const n = new Set(s); for (const p of g.permissions) { if (on) n.add(p.code); else n.delete(p.code); } return n; });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), dataScope: scope, requiresOffice: office, permissions: [...codes] };
      if (role) await api(`/roles/${role.id}`, { method: 'PATCH', body });
      else await api('/roles', { method: 'POST', body });
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={role ? `Edit ${role.name}` : 'New role'} onClose={onClose} width="max-w-3xl">
      <form onSubmit={save} className="space-y-5">
        {error && <Notice tone="bad">{error}</Notice>}
        {role?.isSystem && <Notice tone="info">This is one of the standard roles. Its permissions can be changed, but it cannot be deleted. Nobody can be given more than they hold themselves.</Notice>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Role name" htmlFor="rn" required><Input id="rn" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} disabled={role?.isSystem} /></Field>
          <Field label="Can see" htmlFor="rs" hint="Whose leads, calls and records">
            <Select id="rs" value={scope} onChange={(e) => setScope(e.target.value as RoleRow['dataScope'])}>{Object.entries(SCOPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </Field>
          <Field label="Sign-in" htmlFor="ro" hint="Office roles sign in only from the office">
            <Select id="ro" value={office ? 'office' : 'anywhere'} onChange={(e) => setOffice(e.target.value === 'office')}><option value="office">From the office only</option><option value="anywhere">From anywhere</option></Select>
          </Field>
        </div>

        <div>
          <p className="mb-2 text-sm font-semibold">Permissions <span className="font-normal text-muted">({codes.size} selected)</span></p>
          <div className="grid gap-3 md:grid-cols-2">
            {groups.map((g) => {
              const all = g.permissions.every((p) => codes.has(p.code));
              return (
                <fieldset key={g.module} className="rounded-lg border border-line">
                  <legend className="sr-only">{title(g.module)}</legend>
                  <div className="flex items-center justify-between border-b border-line bg-head px-3 py-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">{title(g.module)}</p>
                    <button type="button" onClick={() => toggleGroup(g, !all)} className="text-xs font-medium text-brand-600 hover:underline">{all ? 'Clear' : 'Select all'}</button>
                  </div>
                  <ul className="space-y-1 p-3">
                    {g.permissions.map((p) => (
                      <li key={p.code}>
                        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                          <input type="checkbox" checked={codes.has(p.code)} onChange={(e) => toggle(p.code, e.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-[#0f625e]" />
                          <span><span className="text-ink">{p.description}</span><span className="block text-xs text-subtle">{p.code}</span></span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>{role ? 'Save role' : 'Create role'}</Button></div>
      </form>
    </Modal>
  );
}

export default function RolesPage() {
  const roles = useApi<RoleRow[]>('/roles');
  const perms = useApi<Group[]>('/permissions');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  async function remove(r: RoleRow) {
    setNotice(null);
    try {
      await api(`/roles/${r.id}`, { method: 'DELETE' });
      roles.reload();
      setNotice({ tone: 'ok', text: `${r.name} was deleted.` });
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    }
  }

  return (
    <>
      <Panel title="Roles and permissions" flush actions={<Button onClick={() => setEditing('new')}><Plus className="h-3.5 w-3.5" aria-hidden /> New role</Button>}>
        {notice && <div className="p-3 pb-0"><Notice tone={notice.tone}>{notice.text}</Notice></div>}
        {roles.error ? <div className="p-4"><Notice tone="bad">{roles.error.message}</Notice></div> : roles.loading && !roles.data ? <Spinner /> : (roles.data?.length ?? 0) === 0 ? <Empty title="No roles" /> : (
          <ul className="divide-y divide-line">
            {roles.data!.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[15px] font-semibold text-ink">{r.name}{r.isSystem && <Badge><Lock className="mr-1 h-3 w-3" aria-hidden />Standard</Badge>}</p>
                  <p className="mt-1 text-xs text-muted">Sees {SCOPE[r.dataScope]!.toLowerCase()} · {r.requiresOffice ? 'office sign-in' : 'signs in from anywhere'} · {r.permissionCount} permissions · {r.userCount} {r.userCount === 1 ? 'person' : 'people'}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(r.id)}>Edit</Button>
                  {!r.isSystem && <Button variant="danger" size="sm" disabled={r.userCount > 0} title={r.userCount > 0 ? 'Move its people to another role first' : undefined} onClick={() => void remove(r)}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {editing && perms.data && <RoleEditor id={editing === 'new' ? null : editing} groups={perms.data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); roles.reload(); }} />}
    </>
  );
}

