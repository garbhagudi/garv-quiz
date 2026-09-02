"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, errText } from "@/lib/client";
import { PageHead, Chip, Notice, Spinner, Empty, when } from "@/components/admin/Ui";

type Person = {
  id: number;
  name: string;
  phone: string;
  email: string;
  class_or_year: string;
  created_at: string;
  organization_id: number;
  organization_name: string;
  organization_slug: string;
  attempts: number;
  best_score: number | null;
  out_of: number | null;
  last_played: string | null;
};

type OrganizationOption = { id: number; name: string; slug: string };

/**
 * Everyone who has ever registered, across every event. This is the contact
 * database the team actually wants out of the exercise, so it is searchable by
 * name, mobile or email and filterable by organization.
 */
export function PeopleClient({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<Person[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [query, setQuery] = useState("");
  const [organizationId, setOrganizationId] = useState<number | "">("");
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setRows(null);
    setError("");
    try {
      const params = new URLSearchParams({ q: query, page: String(page) });
      if (organizationId) params.set("organizationId", String(organizationId));
      const d = await api<{
        participants: Person[];
        total: number;
        pageSize: number;
      }>(`/api/admin/participants?${params}`);
      setRows(d.participants);
      setTotal(d.total);
      setPageSize(d.pageSize);
    } catch (e) {
      setError(errText(e));
      setRows([]);
    }
  }, [query, page, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api<{ organizations: OrganizationOption[] }>("/api/admin/organizations")
      .then((d) => setOrganizations(d.organizations))
      .catch(() => {});
  }, []);

  // Debounce the search box so typing doesn't fire a query per keystroke.
  const [draftQuery, setDraftQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setPage(0);
      setQuery(draftQuery);
    }, 350);
    return () => clearTimeout(t);
  }, [draftQuery]);

  async function remove(p: Person) {
    if (
      !window.confirm(
        `Delete ${p.name} (${p.phone}) and all their answers from ${p.organization_name}?\n\nThey can be restored from the Deleted page.`,
      )
    )
      return;
    try {
      await api(`/api/admin/participants?id=${p.id}`, { method: "DELETE" });
      setNotice(`Removed ${p.name}.`);
      void load();
    } catch (e) {
      setError(errText(e));
    }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <PageHead
        eyebrow="Database"
        title="People"
        sub={`${total} registration${total === 1 ? "" : "s"} across every event.`}
      />

      <Notice tone="good">{notice}</Notice>
      <Notice tone="warn">{error}</Notice>

      <div className="panel">
        <div className="mb-3.5 flex flex-wrap gap-2.5">
          <input
            className="input-sm sm:max-w-xs"
            placeholder="Search name, mobile or email…"
            value={draftQuery}
            onChange={(e) => setDraftQuery(e.target.value)}
          />
          <select
            className="input-sm sm:max-w-[240px]"
            value={organizationId}
            onChange={(e) => {
              setPage(0);
              setOrganizationId(e.target.value ? Number(e.target.value) : "");
            }}
          >
            <option value="">All organizations</option>
            {organizations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        {rows === null ? (
          <Spinner label="Loading people…" />
        ) : rows.length === 0 ? (
          <Empty>{query || organizationId ? "Nothing matches that search." : "No registrations yet."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Mobile</th>
                  <th>Email</th>
                  <th>Organization</th>
                  <th className="text-right">Best</th>
                  <th className="text-right">Tries</th>
                  <th>Last played</th>
                  {canWrite ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="font-semibold">
                      {p.name}
                      {p.class_or_year ? (
                        <div className="text-[12px] font-normal text-muted">{p.class_or_year}</div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap tabular-nums">
                      <a href={`tel:${p.phone}`} className="hover:underline">
                        {p.phone}
                      </a>
                    </td>
                    <td className="max-w-[200px] truncate text-[13px]">
                      {p.email ? (
                        <a href={`mailto:${p.email}`} className="hover:underline">
                          {p.email}
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="text-[13px]">
                      <Link
                        href={`/admin/organizations/${p.organization_id}`}
                        className="text-plum hover:underline"
                      >
                        {p.organization_name}
                      </Link>
                    </td>
                    <td className="text-right font-display font-bold tabular-nums text-plum">
                      {p.best_score === null ? (
                        <Chip tone="warn">none</Chip>
                      ) : (
                        <>
                          {p.best_score}
                          <span className="text-[12px] font-normal text-muted">/{p.out_of}</span>
                        </>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{p.attempts}</td>
                    <td className="whitespace-nowrap text-[12.5px] text-muted">
                      {when(p.last_played)}
                    </td>
                    {canWrite ? (
                      <td className="text-right">
                        <button className="linkish text-coral" onClick={() => void remove(p)}>
                          Delete
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 ? (
          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              className="btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              ← Previous
            </button>
            <span className="text-[13px] text-muted">
              Page {page + 1} of {pages}
            </span>
            <button
              className="btn-ghost btn-sm"
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
            >
              Next →
            </button>
          </div>
        ) : null}
      </div>

    </>
  );
}
