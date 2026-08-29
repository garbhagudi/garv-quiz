"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errText } from "@/lib/client";
import { PageHead, Chip, Notice, Spinner, Empty, when } from "@/components/admin/Ui";

type Row = {
  id: number;
  label: string;
  detail: string;
  deleted_at: string;
  deleted_by: string | null;
  parent?: string;
  parent_deleted?: boolean;
  children?: number;
};

type Kind =
  | "organization"
  | "participant"
  | "attempt"
  | "question"
  | "questionSet"
  | "adminUser";

type Payload = Record<Kind, Row[]>;

/** Order matters: events first, because restoring one brings its people back. */
const SECTIONS: { kind: Kind; title: string; blurb: string }[] = [
  {
    kind: "organization",
    title: "Events",
    blurb: "Restoring an event brings back the students and attempts removed with it.",
  },
  {
    kind: "participant",
    title: "Students",
    blurb: "Restoring a student brings back their attempts.",
  },
  { kind: "attempt", title: "Attempts", blurb: "Individual quiz runs." },
  {
    kind: "questionSet",
    title: "Question sets",
    blurb: "Restoring a set brings back the questions inside it.",
  },
  { kind: "question", title: "Questions", blurb: "" },
  { kind: "adminUser", title: "Team members", blurb: "" },
];

/**
 * The recycle bin. Nothing in this app is ever removed from the database, so
 * everything anyone has deleted is listed here and can be put back.
 */
export function DeletedClient({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string>("");

  const load = useCallback(async () => {
    setError("");
    try {
      const d = await api<{ deleted: Payload }>("/api/admin/deleted");
      setData(d.deleted);
    } catch (e) {
      setError(errText(e));
      setData(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(kind: Kind, row: Row) {
    setBusy(`${kind}:${row.id}`);
    setError("");
    setNotice("");
    try {
      const res = await api<{ counts: Record<string, number> }>("/api/admin/deleted", {
        body: { kind, id: row.id },
      });
      const extra = Object.entries(res.counts)
        .filter(([table, n]) => n > 0 && table !== "organizations")
        .map(([table, n]) => `${n} ${table.replace(/_/g, " ")}`)
        .join(", ");
      setNotice(`Restored “${row.label}”${extra ? ` with ${extra}` : ""}.`);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy("");
    }
  }

  const total = data ? Object.values(data).reduce((n, rows) => n + rows.length, 0) : 0;

  return (
    <>
      <PageHead
        eyebrow="Recycle bin"
        title="Deleted"
        sub="Deleting only hides a record. Everything ever removed is here, and can be put back."
        actions={
          <button className="btn-ghost btn-sm" onClick={() => void load()}>
            Refresh
          </button>
        }
      />

      <Notice tone="good">{notice}</Notice>
      <Notice tone="warn">{error}</Notice>

      {data === null && !error ? <Spinner label="Loading deleted records…" /> : null}

      {data && total === 0 ? (
        <Empty>Nothing has been deleted.</Empty>
      ) : null}

      {data
        ? SECTIONS.filter(({ kind }) => data[kind]?.length).map(({ kind, title, blurb }) => (
            <section key={kind} className="panel mb-4">
              <div className="mb-3">
                <h2 className="font-display text-[16px] font-medium text-plum">
                  {title}{" "}
                  <span className="font-body text-[13px] font-normal text-muted">
                    ({data[kind].length})
                  </span>
                </h2>
                {blurb ? <p className="hint mt-0.5">{blurb}</p> : null}
              </div>

              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>What</th>
                      <th>Detail</th>
                      <th>Deleted</th>
                      <th>By</th>
                      {canWrite ? <th /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {data[kind].map((row) => {
                      // Restoring a child while its parent is still deleted would
                      // leave it stranded and invisible, so ask for the parent first.
                      const stranded = row.parent_deleted === true;
                      return (
                        <tr key={row.id}>
                          <td className="max-w-[380px]">
                            <span className="font-semibold">{row.label}</span>
                            {row.parent ? (
                              <div className="text-[12px] font-normal text-muted">
                                in {row.parent}
                                {stranded ? " (also deleted)" : ""}
                              </div>
                            ) : null}
                            {row.children ? (
                              <div className="text-[12px] font-normal text-muted">
                                {row.children} record{row.children === 1 ? "" : "s"} removed with it
                              </div>
                            ) : null}
                          </td>
                          <td className="text-[13px]">{row.detail || "—"}</td>
                          <td className="whitespace-nowrap text-[12.5px] text-muted">
                            {when(row.deleted_at)}
                          </td>
                          <td className="text-[12.5px] text-muted">{row.deleted_by ?? "—"}</td>
                          {canWrite ? (
                            <td className="whitespace-nowrap text-right">
                              {stranded ? (
                                <Chip>restore its {row.parent ? "parent" : "event"} first</Chip>
                              ) : (
                                <button
                                  className="linkish"
                                  disabled={busy === `${kind}:${row.id}`}
                                  onClick={() => void restore(kind, row)}
                                >
                                  {busy === `${kind}:${row.id}` ? "Restoring…" : "Restore"}
                                </button>
                              )}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        : null}

      {data && total > 0 ? (
        <p className="hint">
          A code, mobile number or email freed by a deletion can be used again straight away. If
          something has since taken it, restoring says so instead of creating a duplicate.
        </p>
      ) : null}
    </>
  );
}
