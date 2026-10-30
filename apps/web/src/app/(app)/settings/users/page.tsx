'use client';

import { Check, Copy, IdCard, KeyRound, Pencil, Plus, Power, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Avatar, Badge, Button, Empty, Field, Input, Notice, Panel, Select, Spinner } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fromNow } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: 'active' | 'inactive';
  designation: string | null;
  joinedOn: string | null;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  role: { id: string; name: string; key: string | null };
  branch: { id: string; name: string } | null;
  manager: { id: string; name: string } | null;
}

interface RoleOption {
  id: string;
  name: string;
  key: string | null;
  dataScope: string;
  requiresOffice: boolean;
}
interface BranchOption {
  id: string;
  name: string;
  isActive: boolean;
}

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

/** Shown once, right after a password is made. It cannot be looked up again. */
function OneTimePassword({ title, name, email, password, onClose }: { title: string; name: string; email?: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the password is on screen to copy by hand */
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <Notice tone="warn">This password is shown only once. Share it with {name} safely. They must choose their own at the first sign-in.</Notice>
      {email && <p className="mt-4 text-sm text-muted">Sign-in email: <span className="font-medium text-ink">{email}</span></p>}
      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-line-strong bg-head px-4 py-3">
        <code className="select-all break-all text-[15px] font-semibold tracking-wide text-ink">{password}</code>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>{copied ? <><Check className="h-3.5 w-3.5" aria-hidden /> Copied</> : <><Copy className="h-3.5 w-3.5" aria-hidden /> Copy</>}</Button>
      </div>
      <div className="mt-5 flex justify-end"><Button onClick={onClose}>Done</Button></div>
    </Modal>
  );
}

function UserForm({ user, roles, branches, managers, onClose, onSaved }: {
  user?: UserRow; roles: RoleOption[]; branches: BranchOption[]; managers: UserRow[]; onClose: () => void; onSaved: (result: { user: UserRow; temporaryPassword?: string }) => void;
}) {
  const [form, setForm] = useState({
    name: user?.name ?? '', email: user?.email ?? '', phone: user?.phone ?? '', roleId: user?.role.id ?? '', branchId: user?.branch?.id ?? '',
    managerId: user?.manager?.id ?? '', joinedOn: user?.joinedOn ?? '', designation: user?.designation ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const on = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const fe = (n: string) => error?.fieldErrors.find((f) => f.field === n)?.message;
  const role = roles.find((r) => r.id === form.roleId);
  // The company's rules: a counsellor reports to an Admin, a Super Admin to nobody.
  const choices = managers.filter((m) => m.id !== user?.id && (role?.key === 'counsellor' ? m.role.key === 'admin' : true));
  const noManager = role?.key === 'super_admin';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const common = {
        name: form.name.trim(), phone: form.phone.trim() || null, roleId: form.roleId, branchId: form.branchId || null,
        managerId: form.managerId || null, joinedOn: form.joinedOn || null, designation: form.designation.trim() || null,
      };
      if (user) onSaved({ user: await api<UserRow>(`/users/${user.id}`, { method: 'PATCH', body: common }) });
      else onSaved(await api<{ user: UserRow; temporaryPassword: string }>('/users', { method: 'POST', body: { ...common, email: form.email.trim() } }));
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server.'));
      setBusy(false);
    }
  }

  return (
    <Modal title={user ? `Edit ${user.name}` : 'Add a person'} onClose={onClose} width="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" htmlFor="un" required error={fe('name')}><Input id="un" value={form.name} onChange={on('name')} required minLength={2} /></Field>
          <Field label="Work email" htmlFor="ue" required error={fe('email')}><Input id="ue" type="email" value={form.email} onChange={on('email')} required disabled={!!user} /></Field>
          <Field label="Mobile number" htmlFor="up" error={fe('phone')} hint="Used when calls go through your phone"><Input id="up" inputMode="tel" value={form.phone} onChange={on('phone')} /></Field>
          <Field label="Designation" htmlFor="ud" error={fe('designation')}><Input id="ud" value={form.designation} onChange={on('designation')} /></Field>
          <Field label="Role" htmlFor="ur" required error={fe('roleId')} hint={role ? `Sees ${role.dataScope === 'all' ? 'everyone\'s records' : role.dataScope === 'team' ? 'their own team\'s records' : 'only their own records'}` : undefined}>
            <Select id="ur" value={form.roleId} onChange={on('roleId')} required><option value="">Choose a role</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
          </Field>
          <Field label="Reports to" htmlFor="um" required={role?.key === 'counsellor'} error={fe('managerId')} hint={role?.key === 'counsellor' && choices.length === 0 ? 'Add an Admin first. A counsellor reports to an Admin.' : undefined}>
            <Select id="um" value={noManager ? '' : form.managerId} onChange={on('managerId')} disabled={noManager}><option value="">{role?.key === 'counsellor' ? 'Choose an Admin' : 'Nobody'}</option>{choices.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role.name})</option>)}</Select>
          </Field>
          <Field label="Branch" htmlFor="ub" required={!!role?.requiresOffice} error={fe('branchId')} hint={role?.requiresOffice ? 'Needed, because they sign in from the office' : undefined}>
            <Select id="ub" value={form.branchId} onChange={on('branchId')}><option value="">No branch</option>{branches.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
          </Field>
          <Field label="Joined on" htmlFor="uj" error={fe('joinedOn')}><Input id="uj" type="date" value={form.joinedOn} onChange={on('joinedOn')} /></Field>
        </div>
        {!user && <p className="text-xs text-muted">A one-time password is made for the person. You will see it once, after saving.</p>}
        <div className="flex justify-end gap-2 pt-1"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>{user ? 'Save changes' : 'Add person'}</Button></div>
      </form>
    </Modal>
  );
}

export default function UsersPage() {
  const { can } = useAuth();
  const manage = can('user.manage');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [roleId, setRoleId] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [secret, setSecret] = useState<{ title: string; name: string; email?: string; password: string } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const query = useMemo(() => ({ limit: 100, q: debounced || undefined, roleId: roleId || undefined, status: status || undefined }), [debounced, roleId, status]);
  const users = useApi<Page<UserRow>>('/users', query);
  const roles = useApi<RoleOption[]>('/roles');
  const branches = useApi<BranchOption[]>(can('branch.read') ? '/branches' : null);
  const everyone = useApi<Page<UserRow>>(manage ? '/users' : null, { limit: 100, status: 'active' });

  async function toggle(u: UserRow) {
    setNotice(null);
    try {
      await api(`/users/${u.id}`, { method: 'PATCH', body: { status: u.status === 'active' ? 'inactive' : 'active' } });
      users.reload();
      setNotice({ tone: 'ok', text: u.status === 'active' ? `${u.name} can no longer sign in. Their history stays.` : `${u.name} can sign in again.` });
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    }
  }

  async function reset(u: UserRow) {
    setNotice(null);
    try {
      const r = await api<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`, { method: 'POST', body: {} });
      setSecret({ title: 'New one-time password', name: u.name, email: u.email, password: r.temporaryPassword });
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    }
  }

  const items = users.data?.items ?? [];
  return (
    <>
      <Panel
        title="Users"
        flush
        actions={manage && <Button onClick={() => setEditing('new')}><Plus className="h-3.5 w-3.5" aria-hidden /> Add person</Button>}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" aria-hidden />
            <Input aria-label="Search people" placeholder="Search name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <Select aria-label="Role" value={roleId} onChange={(e) => setRoleId(e.target.value)} className="w-44"><option value="">Every role</option>{roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-44"><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Switched off</option></Select>
        </div>
        {notice && <div className="p-3 pb-0"><Notice tone={notice.tone}>{notice.text}</Notice></div>}

        {users.error ? <div className="p-4"><Notice tone="bad">{users.error.message}</Notice></div> : users.loading && !users.data ? <Spinner /> : items.length === 0 ? <Empty title="No one matches" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-head text-xs uppercase tracking-wide text-muted">
                <tr><th className="px-4 py-2.5 font-semibold">Person</th><th className="px-3 py-2.5 font-semibold">Role</th><th className="px-3 py-2.5 font-semibold">Reports to</th><th className="px-3 py-2.5 font-semibold">Branch</th><th className="px-3 py-2.5 font-semibold">Last sign-in</th><th className="px-3 py-2.5 font-semibold">Status</th>{manage && <th className="px-4 py-2.5 text-right font-semibold"><span className="sr-only">Actions</span></th>}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((u) => (
                  <tr key={u.id} className="hover:bg-mint-50">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={u.name} size={32} tone="soft" />
                        <div className="min-w-0"><p className="truncate font-medium text-ink">{u.name}</p><p className="truncate text-xs text-muted">{u.email}{u.designation ? ` · ${u.designation}` : ''}</p></div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5"><Badge tone="brand">{u.role.name}</Badge></td>
                    <td className="px-3 py-2.5 text-muted">{u.manager?.name ?? '—'}</td>
                    <td className="px-3 py-2.5 text-muted">{u.branch?.name ?? '—'}</td>
                    <td className="px-3 py-2.5 text-muted" title={u.lastLoginAt ? fmtDate(u.lastLoginAt) : ''}>{u.lastLoginAt ? fromNow(u.lastLoginAt) : u.mustChangePassword ? 'Not yet' : 'Never'}</td>
                    <td className="px-3 py-2.5">{u.status === 'active' ? <Badge tone="ok">Active</Badge> : <Badge>Switched off</Badge>}</td>
                    {manage && (
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1">
                          <Link href={`/settings/users/${u.id}`} aria-label={`Details of ${u.name}`} title="Details, bank and sign-ins" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-head hover:text-ink"><IdCard className="h-[18px] w-[18px]" /></Link>
                          <button onClick={() => setEditing(u)} aria-label={`Edit ${u.name}`} title="Edit" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-head hover:text-ink"><Pencil className="h-[18px] w-[18px]" /></button>
                          <button onClick={() => void reset(u)} aria-label={`Reset password of ${u.name}`} title="Reset password" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-head hover:text-ink"><KeyRound className="h-[18px] w-[18px]" /></button>
                          <button onClick={() => void toggle(u)} aria-label={u.status === 'active' ? `Switch off ${u.name}` : `Switch on ${u.name}`} title={u.status === 'active' ? 'Switch off' : 'Switch on'} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-bad-50 hover:text-bad"><Power className="h-[18px] w-[18px]" /></button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {editing && (
        <UserForm
          user={editing === 'new' ? undefined : editing}
          roles={roles.data ?? []}
          branches={branches.data ?? []}
          managers={everyone.data?.items ?? []}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            setEditing(null);
            users.reload();
            everyone.reload();
            if (r.temporaryPassword) setSecret({ title: `${r.user.name} was added`, name: r.user.name, email: r.user.email, password: r.temporaryPassword });
            else setNotice({ tone: 'ok', text: `${r.user.name} was updated.` });
          }}
        />
      )}
      {secret && <OneTimePassword {...secret} onClose={() => setSecret(null)} />}
    </>
  );
}

