"use client";

import Link from "next/link";
import { PageHead, Stats, Chip, Empty, when } from "@/components/admin/Ui";

type OrganizationRow = {
  id: number;
  slug: string;
  name: string;
  city: string;
  is_open: boolean;
  event_date: string | null;
  created_at: string;
  registered: number;
  completed: number;
};

type EntryRow = {
  name: string;
  phone: string;
  organization: string;
  organization_id: number;
  score: number;
  max_score: number;
  submitted_at: string;
};

export function Overview({
  firstName,
  stats,
  organizations,
  entries,
}: {
  firstName: string;
  stats: {
    organizations: number;
    organizations_open: number;
    participants: number;
    attempts: number;
    questions: number;
    sets: number;
  };
  organizations: OrganizationRow[];
  entries: EntryRow[];
}) {
  return (
    <>
      <PageHead
        eyebrow="GarbhaGudi Quiz"
        title={`Hello, ${firstName}`}
        actions={
          <>
            <Link href="/admin/organizations?new=1" className="btn-accent btn-sm">
              New organization
            </Link>
            <Link href="/admin/questions" className="btn-ghost btn-sm">
              Edit questions
            </Link>
          </>
        }
      />

      <Stats
        items={[
          { label: "Organizations", value: stats.organizations, sub: `${stats.organizations_open} open` },
          { label: "Students", value: stats.participants, sub: "registered" },
          { label: "Quizzes done", value: stats.attempts, sub: "completed" },
          { label: "Questions", value: stats.questions, sub: "active" },
          { label: "Question sets", value: stats.sets, sub: "in use" },
          {
            label: "Live now",
            value: stats.organizations_open,
            sub: stats.organizations_open ? "accepting entries" : "all closed",
            tone: stats.organizations_open ? "good" : "plain",
          },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-5">
        {/* --------------------------- organizations --------------------------- */}
        <section className="panel lg:col-span-3">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-display text-[16px] font-medium text-plum">Recent organizations</h2>
            <Link href="/admin/organizations" className="linkish">
              See all
            </Link>
          </div>

          {organizations.length ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Organization</th>
                    <th>Code</th>
                    <th className="text-right">Reg.</th>
                    <th className="text-right">Done</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {organizations.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link
                          href={`/admin/organizations/${s.id}`}
                          className="font-display font-medium text-plum hover:underline"
                        >
                          {s.name}
                        </Link>
                        {s.city ? (
                          <div className="text-[12px] text-muted">{s.city}</div>
                        ) : null}
                      </td>
                      <td>
                        <code className="rounded bg-petal px-1.5 py-0.5 text-[12.5px] text-plum">
                          {s.slug}
                        </code>
                      </td>
                      <td className="text-right tabular-nums">{s.registered}</td>
                      <td className="text-right font-semibold tabular-nums">{s.completed}</td>
                      <td>
                        <Chip tone={s.is_open ? "good" : "neutral"}>
                          {s.is_open ? "Open" : "Closed"}
                        </Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>
              No organizations yet.{" "}
              <Link href="/admin/organizations?new=1" className="linkish">
                Create the first one
              </Link>
              .
            </Empty>
          )}
        </section>

        {/* -------------------------- latest entries --------------------- */}
        <section className="panel lg:col-span-2">
          <h2 className="mb-3 font-display text-[16px] font-medium text-plum">Latest entries</h2>
          {entries.length ? (
            <ul className="space-y-2">
              {entries.map((e, i) => (
                <li
                  key={`${e.phone}-${i}`}
                  className="flex items-baseline justify-between gap-3 border-b border-ink/[0.07] pb-2 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="truncate font-display text-[14px] font-medium text-ink">
                      {e.name}
                    </div>
                    <div className="truncate text-[12px] text-muted">
                      {e.organization} · {when(e.submitted_at)}
                    </div>
                  </div>
                  <div className="shrink-0 font-display text-[15px] font-bold tabular-nums text-plum">
                    {e.score}
                    <span className="text-[12px] font-normal text-muted">/{e.max_score}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing submitted yet.</Empty>
          )}
        </section>
      </div>
    </>
  );
}
