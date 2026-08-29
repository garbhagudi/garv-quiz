"use client";

import { useEffect, useState } from "react";
import { api, errText } from "@/lib/client";
import { PageHead, Notice, Spinner, Empty, when } from "@/components/admin/Ui";

type Entry = {
  id: number;
  admin_email: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  created_at: string;
};

/** Plain-English labels, so the log reads as a story rather than event codes. */
const LABELS: Record<string, string> = {
  signin: "signed in",
  "organization.create": "created organization",
  "organization.update": "updated organization",
  "organization.delete": "deleted organization",
  "organization.clearEntries": "cleared entries for",
  "organization.export": "exported results for",
  "set.create": "created question set",
  "set.update": "updated question set",
  "set.delete": "deleted question set",
  "question.create": "added question",
  "question.update": "edited question",
  "question.delete": "deleted question",
  "question.reorder": "reordered questions in set",
  "attempt.delete": "deleted an attempt",
  "participant.delete": "deleted participant",
  "user.create": "added team member",
  "user.update": "updated team member",
  "user.delete": "removed team member",
  "password.change": "changed their password",
  restore: "restored",
};

const TONE = (action: string) =>
  action === "restore"
    ? "text-moss"
    : action.includes("delete") || action.includes("clear")
    ? "text-coral"
    : action.includes("create") || action.includes("add")
      ? "text-moss"
      : "text-plum";

export function ActivityClient() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<{ entries: Entry[] }>("/api/admin/audit?limit=200")
      .then((d) => setEntries(d.entries))
      .catch((e) => {
        setError(errText(e));
        setEntries([]);
      });
  }, []);

  return (
    <>
      <PageHead
        eyebrow="Log"
        title="Activity"
        sub="The last 200 staff actions."
      />

      <Notice tone="warn">{error}</Notice>

      <div className="panel">
        {entries === null ? (
          <Spinner label="Loading activity…" />
        ) : entries.length === 0 ? (
          <Empty>Nothing logged yet.</Empty>
        ) : (
          <ol className="space-y-0">
            {entries.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-ink/[0.07] py-2.5 text-[13.5px] last:border-0"
              >
                <span className="font-display font-medium text-ink">{e.admin_email}</span>
                <span className={TONE(e.action)}>{LABELS[e.action] ?? e.action}</span>
                {e.target ? <span className="font-semibold text-plum">{e.target}</span> : null}
                <span className="ml-auto whitespace-nowrap text-[12.5px] text-muted">
                  {when(e.created_at)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
