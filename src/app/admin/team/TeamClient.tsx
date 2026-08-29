"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errText } from "@/lib/client";
import { PageHead, Chip, Notice, Spinner, Empty, Modal, Field, when } from "@/components/admin/Ui";
import type { AdminUser, Role } from "@/lib/types";

const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including managing these accounts.",
  admin: "Create organizations, edit questions, see and clear all data.",
  viewer: "Read-only. Can see results and export, but change nothing.",
};

export function TeamClient({ meId, isOwner }: { meId: number; isOwner: boolean }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const d = await api<{ users: AdminUser[] }>("/api/admin/users");
      setUsers(d.users);
    } catch (e) {
      setError(errText(e));
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHead
        eyebrow="Access"
        title="Team"
        sub="Who can sign in to this admin panel."
        actions={
          <>
            <button className="btn-ghost btn-sm" onClick={() => setChangingPassword(true)}>
              Change my password
            </button>
            {isOwner ? (
              <button className="btn-accent btn-sm" onClick={() => setInviting(true)}>
                Add person
              </button>
            ) : null}
          </>
        }
      />

      <Notice tone="good">{notice}</Notice>
      <Notice tone="warn">{error}</Notice>

      <div className="panel">
        {users === null ? (
          <Spinner label="Loading team…" />
        ) : users.length === 0 ? (
          <Empty>No accounts found.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last signed in</th>
                  <th>Added</th>
                  {isOwner ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="font-semibold">
                      {u.name}
                      {Number(u.id) === meId ? (
                        <span className="ml-2 font-display text-[11px] uppercase text-apricot-deep">
                          you
                        </span>
                      ) : null}
                    </td>
                    <td className="text-[13px]">{u.email}</td>
                    <td>
                      <Chip tone={u.role === "owner" ? "info" : "neutral"}>{u.role}</Chip>
                    </td>
                    <td>
                      <Chip tone={u.is_active ? "good" : "warn"}>
                        {u.is_active ? "Active" : "Disabled"}
                      </Chip>
                    </td>
                    <td className="whitespace-nowrap text-[12.5px] text-muted">
                      {when(u.last_login_at)}
                    </td>
                    <td className="whitespace-nowrap text-[12.5px] text-muted">
                      {when(u.created_at, false)}
                    </td>
                    {isOwner ? (
                      <td className="whitespace-nowrap text-right">
                        <button className="linkish mr-3" onClick={() => setEditing(u)}>
                          Edit
                        </button>
                        {Number(u.id) !== meId ? (
                          <button
                            className="linkish text-coral"
                            onClick={async () => {
                              if (!window.confirm(`Remove ${u.email} from the team?`)) return;
                              try {
                                await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
                                setNotice(`Removed ${u.email}.`);
                                void load();
                              } catch (e) {
                                setError(errText(e));
                              }
                            }}
                          >
                            Remove
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel mt-4">
        <h2 className="mb-2 font-display text-[15px] font-medium text-plum">What the roles mean</h2>
        <dl className="space-y-1.5 text-[13.5px]">
          {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
            <div key={r} className="flex flex-wrap gap-x-2">
              <dt className="font-display font-medium capitalize text-plum">{r}</dt>
              <dd className="text-[#5B486F]">{ROLE_HELP[r]}</dd>
            </div>
          ))}
        </dl>
      </div>

      {inviting ? (
        <InviteModal
          onClose={() => setInviting(false)}
          onSaved={(msg) => {
            setInviting(false);
            setNotice(msg);
            void load();
          }}
        />
      ) : null}

      {editing ? (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setNotice(msg);
            void load();
          }}
        />
      ) : null}

      {changingPassword ? (
        <PasswordModal
          onClose={() => setChangingPassword(false)}
          onSaved={(msg) => {
            setChangingPassword(false);
            setNotice(msg);
          }}
        />
      ) : null}
    </>
  );
}

/* -------------------------------- invite --------------------------------- */

function InviteModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    role: "admin" as Role,
    password: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/api/admin/users", { body: form });
      onSaved(`Added ${form.email}. Share the password with them privately.`);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add someone to the team" onClose={onClose}>
      <form onSubmit={save} noValidate className="space-y-3">
        <Field label="Full name">
          <input
            className="input-sm"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Email">
          <input
            className="input-sm"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field label="Role" hint={ROLE_HELP[form.role]}>
          <select
            className="input-sm"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
          >
            <option value="admin">Admin</option>
            <option value="viewer">Viewer (read-only)</option>
            <option value="owner">Owner</option>
          </select>
        </Field>
        <Field
          label="Temporary password"
          hint="At least 10 characters. They can change it once signed in."
        >
          <input
            className="input-sm"
            type="text"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            autoComplete="off"
          />
        </Field>

        <Notice tone="warn">{error}</Notice>

        <div className="flex flex-wrap gap-2.5 pt-1">
          <button type="submit" className="btn-primary btn-sm" disabled={busy}>
            {busy ? "Adding…" : "Add person"}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------- edit user -------------------------------- */

function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<Role>(user.role);
  const [isActive, setIsActive] = useState(user.is_active);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: { name, role, isActive, ...(password ? { password } : {}) },
      });
      onSaved(`Updated ${user.email}.`);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit ${user.email}`} onClose={onClose}>
      <form onSubmit={save} noValidate className="space-y-3">
        <Field label="Full name">
          <input className="input-sm" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role" hint={ROLE_HELP[role]}>
          <select
            className="input-sm"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            <option value="admin">Admin</option>
            <option value="viewer">Viewer (read-only)</option>
            <option value="owner">Owner</option>
          </select>
        </Field>
        <label className="flex items-center gap-2.5 text-[14px] text-ink">
          <input
            type="checkbox"
            className="h-[18px] w-[18px] accent-plum"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          Can sign in
        </label>
        <Field label="Reset password" hint="Leave blank to keep the current one.">
          <input
            className="input-sm"
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            placeholder="new password (min 10 characters)"
          />
        </Field>

        <Notice tone="warn">{error}</Notice>

        <div className="flex flex-wrap gap-2.5 pt-1">
          <button type="submit" className="btn-primary btn-sm" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------- own password ------------------------------- */

function PasswordModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", repeat: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (form.newPassword !== form.repeat) return setError("The two new passwords do not match.");
    setBusy(true);
    try {
      await api("/api/admin/password", {
        body: { currentPassword: form.currentPassword, newPassword: form.newPassword },
      });
      onSaved("Password changed.");
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Change my password" onClose={onClose}>
      <form onSubmit={save} noValidate className="space-y-3">
        <Field label="Current password">
          <input
            className="input-sm"
            type="password"
            autoComplete="current-password"
            value={form.currentPassword}
            onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
          />
        </Field>
        <Field label="New password" hint="At least 10 characters.">
          <input
            className="input-sm"
            type="password"
            autoComplete="new-password"
            value={form.newPassword}
            onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
          />
        </Field>
        <Field label="Repeat new password">
          <input
            className="input-sm"
            type="password"
            autoComplete="new-password"
            value={form.repeat}
            onChange={(e) => setForm({ ...form, repeat: e.target.value })}
          />
        </Field>

        <Notice tone="warn">{error}</Notice>

        <div className="flex flex-wrap gap-2.5 pt-1">
          <button type="submit" className="btn-primary btn-sm" disabled={busy}>
            {busy ? "Changing…" : "Change password"}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
