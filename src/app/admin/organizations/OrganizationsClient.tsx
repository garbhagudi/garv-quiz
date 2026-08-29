"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errText } from "@/lib/client";
import { PageHead, Chip, Notice, Spinner, Empty, Modal, when } from "@/components/admin/Ui";
import {
  OrganizationForm,
  blankDraft,
  draftFromOrganization,
  type OrganizationDraft,
  type SetOption,
} from "@/components/admin/OrganizationForm";
import type { Organization } from "@/lib/types";

type Row = Organization & {
  set_name: string | null;
  registered: number;
  completed: number;
  set_questions: number;
  top_score: number | null;
};

export function OrganizationsClient({ canWrite }: { canWrite: boolean }) {
  const params = useSearchParams();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sets, setSets] = useState<SetOption[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [editing, setEditing] = useState<{ id?: number; draft: OrganizationDraft } | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const [a, b] = await Promise.all([
        api<{ organizations: Row[] }>("/api/admin/organizations"),
        api<{ sets: SetOption[] }>("/api/admin/sets"),
      ]);
      setRows(a.organizations);
      setSets(b.sets);
      return b.sets;
    } catch (e) {
      setError(errText(e));
      setRows([]);
      return [];
    }
  }, []);

  useEffect(() => {
    void load().then((loadedSets) => {
      // `?new=1` from the overview page opens the create form straight away.
      if (params.get("new") === "1" && canWrite) {
        const usable = loadedSets.find((s) => !s.is_archived && s.active_count > 0);
        setEditing({ draft: blankDraft(usable?.id ?? null) });
      }
    });
  }, [load, params, canWrite]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !rows) return rows ?? [];
    return rows.filter((r) =>
      [r.name, r.slug, r.city].some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [rows, search]);

  function openNew() {
    const usable = sets.find((s) => !s.is_archived && s.active_count > 0);
    setEditing({ draft: blankDraft(usable?.id ?? null) });
  }

  return (
    <>
      <PageHead
        eyebrow="Events"
        title="Organizations"
        sub="One organization is one event."
        actions={
          canWrite ? (
            <button className="btn-accent btn-sm" onClick={openNew}>
              New organization
            </button>
          ) : (
            <Chip>View only</Chip>
          )
        }
      />

      <Notice tone="good">{notice}</Notice>
      <Notice tone="warn">{error}</Notice>

      <div className="panel">
        <input
          className="input-sm mb-3.5 sm:max-w-xs"
          placeholder="Search by name, code or city…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {rows === null ? (
          <Spinner label="Loading organizations…" />
        ) : filtered.length === 0 ? (
          <Empty>
            {rows.length === 0 ? (
              canWrite ? (
                <>
                  No organizations yet.{" "}
                  <button className="linkish" onClick={openNew}>
                    Create the first one
                  </button>
                  .
                </>
              ) : (
                "No organizations yet."
              )
            ) : (
              "Nothing matches that search."
            )}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Code</th>
                  <th>Question set</th>
                  <th className="text-right">Reg.</th>
                  <th className="text-right">Done</th>
                  <th className="text-right">Top</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link
                        href={`/admin/organizations/${s.id}`}
                        className="font-display font-medium text-plum hover:underline"
                      >
                        {s.name}
                      </Link>
                      <div className="text-[12px] text-muted">
                        {[s.city, s.event_date ? when(s.event_date, false) : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </td>
                    <td>
                      <code className="rounded bg-petal px-1.5 py-0.5 text-[12.5px] text-plum">
                        {s.slug}
                      </code>
                    </td>
                    <td className="text-[13px]">
                      {s.set_name ?? <span className="text-coral">none</span>}
                      <div className="text-[11.5px] text-muted">
                        asks {s.question_count ?? s.set_questions} of {s.set_questions}
                      </div>
                    </td>
                    <td className="text-right tabular-nums">{s.registered}</td>
                    <td className="text-right font-semibold tabular-nums">{s.completed}</td>
                    <td className="text-right tabular-nums">{s.top_score ?? "—"}</td>
                    <td>
                      <Chip tone={s.is_open ? "good" : "neutral"}>
                        {s.is_open ? "Open" : "Closed"}
                      </Chip>
                    </td>
                    <td className="whitespace-nowrap text-[12.5px] text-muted">
                      {when(s.created_at, false)}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <Link
                        href={`/admin/organizations/${s.slug}/dashboard`}
                        className="linkish mr-3"
                      >
                        Live
                      </Link>
                      <Link href={`/admin/organizations/${s.id}`} className="linkish mr-3">
                        Results
                      </Link>
                      <button
                        className="linkish"
                        onClick={() => setEditing({ id: s.id, draft: draftFromOrganization(s) })}
                      >
                        {canWrite ? "Edit" : "View"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing ? (
        <Modal
          title={editing.id ? "Edit organization" : "New organization"}
          onClose={() => setEditing(null)}
          wide
        >
          <OrganizationForm
            draft={editing.draft}
            setDraft={(d) => setEditing({ ...editing, draft: d })}
            sets={sets}
            organizationId={editing.id}
            readOnly={!canWrite}
            onCancel={() => setEditing(null)}
            onSaved={(organization) => {
              setEditing(null);
              setNotice(
                editing.id
                  ? `Saved “${organization.name}”.`
                  : `Created “${organization.name}”. Students enter the code ${organization.slug}.`,
              );
              void load();
            }}
          />
        </Modal>
      ) : null}
    </>
  );
}
