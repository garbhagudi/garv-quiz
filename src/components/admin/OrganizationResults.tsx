"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errText } from "@/lib/client";
import {
  acceptingEntries,
  closesInMs,
  roundEnded,
  refreshMs,
  REFRESH_IDLE_MS,
} from "@/lib/eventWindow";
import {
  PageHead,
  Stats,
  Chip,
  Notice,
  Spinner,
  Empty,
  Modal,
  Field,
  secs,
  when,
  MEDALS,
} from "./Ui";
import { OrganizationForm, draftFromOrganization, type OrganizationDraft, type SetOption } from "./OrganizationForm";
import type { Organization } from "@/lib/types";
import { QuestionText } from "@/components/QuestionText";
import { RunPanel, fmtLeft } from "./RunPanel";

/* -------------------------------- shapes --------------------------------- */

type Result = {
  id: number;
  public_id: string;
  participant_id: number;
  rank: number;
  name: string;
  phone: string;
  email: string;
  class_or_year: string;
  score: number;
  max_score: number;
  correct_count: number;
  question_count: number;
  accuracy: number;
  answer_ms: number;
  elapsed_ms: number;
  submitted_at: string;
  attempt_no: number;
  attempts_by_student: number;
  repeat: boolean;
};

type Analysis = {
  question_text: string;
  correct_text: string;
  asked: number;
  got_right: number;
  pct_correct: number;
  avg_ms: number;
};

type Pending = {
  id: number;
  name: string;
  phone: string;
  email: string;
  class_or_year: string;
  created_at: string;
  attempts: number;
};

type Detail = {
  organization: Organization;
  summary: {
    registered: number;
    completed: number;
    in_progress: number;
    answering: number;
    not_finished: number;
    avg_score: number;
    top_score: number;
    out_of: number;
    avg_answer_ms: number;
  };
  results: Result[];
  analysis: Analysis[];
  notFinished: Pending[];
};

type Tab = "run" | "results" | "analysis" | "pending" | "settings";

/* ================================ view ================================== */

export function OrganizationResults({
  organizationId,
  canWrite,
  compact,
}: {
  organizationId: number;
  /** Viewers get the same data, without the buttons that change it. */
  canWrite: boolean;
  /** `/s/<code>/admin` renders without the admin chrome, so it adds its own links. */
  compact?: boolean;
}) {
  const [data, setData] = useState<Detail | null>(null);
  const [sets, setSets] = useState<SetOption[]>([]);
  // The run screen opens first: on the day, starting the round is what this
  // page is for. Reading results at a desk is one click away.
  const [tab, setTab] = useState<Tab>("run");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Only ticks while a round has a deadline, so the header countdown stays
  // honest without the page re-rendering every second for no reason.
  const [now, setNow] = useState(() => Date.now());

  const [draft, setDraft] = useState<OrganizationDraft | null>(null);
  const [openAttempt, setOpenAttempt] = useState<Result | null>(null);
  const [danger, setDanger] = useState<"entries" | "all" | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setRefreshing(true);
      setError("");
      try {
        const d = await api<Detail>(`/api/admin/organizations/${organizationId}`);
        setData(d);
        setDraft(draftFromOrganization(d.organization));
      } catch (e) {
        setError(errText(e));
      } finally {
        setRefreshing(false);
      }
    },
    [organizationId],
  );

  useEffect(() => {
    void load();
    void api<{ sets: SetOption[] }>("/api/admin/sets")
      .then((r) => setSets(r.sets))
      .catch(() => {});
  }, [load]);

  // While a session is live, refresh on a timer so the room's scores appear
  // without anybody tapping anything.
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => void load(true), 10_000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  /**
   * The run screen is watched rather than read, so it refreshes itself without
   * anybody ticking a box. It asks the `/live` route, not the full detail one:
   * five numbers and five names instead of the whole results table, the
   * question analysis and the did-not-finish list — and one database round trip
   * instead of five.
   *
   * Paced by `refreshMs`, shared with the standalone screen: quickly only while
   * a round is counting down or somebody is still answering. An event sitting
   * open with nothing running changes no faster than a person can register.
   * Nothing polls at all while the browser tab is hidden.
   */
  useEffect(() => {
    if (tab !== "run") return;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (!document.hidden) {
        try {
          const live = await api<{ organization: Organization; summary: Detail["summary"]; top: Result[] }>(
            `/api/admin/organizations/${organizationId}/live`,
          );
          // Patch in only what the run screen draws; the other tabs keep the
          // data the last full load gave them.
          setData((cur) =>
            cur
              ? {
                  ...cur,
                  organization: { ...cur.organization, ...live.organization },
                  summary: { ...cur.summary, ...live.summary },
                  results: live.top.length ? live.top : cur.results,
                }
              : cur,
          );
        } catch {
          /* a blip on hall wifi is not worth an error banner on this screen */
        }
      }
      timer = setTimeout(tick, paceRef.current);
    };
    void tick();
    return () => clearTimeout(timer);
  }, [tab, organizationId]);

  // Read inside the polling loop, so changing pace never restarts it.
  const paceRef = useRef(REFRESH_IDLE_MS);
  paceRef.current = data
    ? refreshMs(data.organization, data.summary.answering, now)
    : REFRESH_IDLE_MS;

  const closesAt = data?.organization.closes_at ?? null;
  useEffect(() => {
    if (!closesAt) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [closesAt]);

  const shareUrl = useMemo(
    () => (data ? `${typeof window === "undefined" ? "" : window.location.origin}/s/${data.organization.slug}` : ""),
    [data],
  );

  /**
   * Opens the entries and, when the question set is timed, gives the round that
   * long to run. Sent as its own action so the server works out the deadline —
   * a room's timing is not something to hand to a browser clock.
   */
  async function startRound() {
    if (!data) return;
    try {
      const res = await api<{ organization: { closes_at: string | null } }>(
        `/api/admin/organizations/${organizationId}`,
        { method: "PATCH", body: { startRound: true } },
      );
      const left = closesInMs(res.organization);
      setNotice(
        left === null
          ? "Entries are open. This set has no time limit, so close them yourself when you are done."
          : `Round started — entries close in ${Math.round(left / 60000)} minutes.`,
      );
      void load();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function toggleOpen() {
    if (!data || !draft) return;
    try {
      await api(`/api/admin/organizations/${organizationId}`, {
        method: "PATCH",
        body: { ...draft, isOpen: !data.organization.is_open },
      });
      setNotice(data.organization.is_open ? "Entries are now closed." : "Entries are open again.");
      void load();
    } catch (e) {
      setError(errText(e));
    }
  }

  if (!data && !error) return <Spinner label="Loading results…" />;
  if (!data)
    return (
      <>
        <Notice tone="warn">{error}</Notice>
        <button className="btn-ghost btn-sm" onClick={() => void load()}>
          Try again
        </button>
      </>
    );

  const s = data.organization;
  const podium = data.results.slice(0, 3);
  // One rule decides this, shared with the server and the student's page.
  const live = acceptingEntries(s, now);
  const ended = roundEnded(s, now);
  const leftMs = closesInMs(s, now);

  return (
    <>
      <PageHead
        eyebrow={compact ? "Staff view" : "Organization"}
        title={s.name}
        sub={
          <>
            Code <code className="rounded bg-white px-1.5 py-0.5 text-plum">{s.slug}</code>
            {s.city ? ` · ${s.city}` : ""}
            {s.event_date ? ` · ${when(s.event_date, false)}` : ""} ·{" "}
            <Chip tone={live ? "good" : "neutral"}>
              {live
                ? leftMs === null
                  ? "Open"
                  : `Open · closes in ${fmtLeft(leftMs)}`
                : ended
                  ? "Round over"
                  : "Closed"}
            </Chip>
          </>
        }
        actions={
          <>
            <button
              className="btn-ghost btn-sm"
              onClick={() => void load()}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-plum-soft">
              <input
                type="checkbox"
                className="h-4 w-4 accent-plum"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Live
            </label>
            <a
              className="btn-accent btn-sm"
              href={`/api/admin/organizations/${organizationId}/export`}
              download
            >
              Download Excel
            </a>
            {canWrite ? (
              <>
                {/* Start is the one that runs a round. The switch beside it is
                    still there for opening or closing by hand. */}
                {live && leftMs !== null ? null : (
                  <button className="btn-primary btn-sm" onClick={() => void startRound()}>
                    {ended ? "Start another round" : "Start round"}
                  </button>
                )}
                <button className="btn-ghost btn-sm" onClick={() => void toggleOpen()}>
                  {live ? "Close entries" : "Reopen entries"}
                </button>
              </>
            ) : null}
          </>
        }
      />

      <Notice tone="good">{notice}</Notice>
      <Notice tone="warn">{error}</Notice>

      <Stats
        items={[
          { label: "Registered", value: data.summary.registered },
          { label: "Completed", value: data.summary.completed, tone: "good" },
          {
            // The same people the "Did not finish" tab lists, so the number and
            // the names can never disagree. Clicking it goes straight there.
            label: "Unfinished",
            value: data.summary.not_finished,
            tone: data.summary.not_finished ? "warn" : "plain",
            sub: data.summary.not_finished ? "see who" : undefined,
            onClick: data.summary.not_finished ? () => setTab("pending") : undefined,
          },
          { label: "Average", value: data.summary.avg_score, sub: `of ${data.summary.out_of}` },
          { label: "Top score", value: data.summary.top_score, sub: `of ${data.summary.out_of}` },
          { label: "Avg answer time", value: secs(data.summary.avg_answer_ms) },
        ]}
      />

      {/* ------------------------------ podium ----------------------------- */}
      {podium.length ? (
        <section className="mb-5 rounded-xl2 border border-apricot/40 bg-gradient-to-br from-[#FFF6EC] to-[#FDEDF3] p-4">
          <h2 className="mb-3 font-display text-[13px] font-medium uppercase tracking-[0.14em] text-apricot-deep">
            Winners
          </h2>
          <div className="grid gap-2.5 sm:grid-cols-3">
            {podium.map((r, i) => (
              <div key={r.id} className="rounded-[14px] bg-white/80 px-3.5 py-3">
                <div className="mb-1 text-[20px]" aria-hidden="true">
                  {MEDALS[i]}
                </div>
                <div className="font-display text-[15.5px] font-medium leading-snug text-ink">
                  {r.name}
                </div>
                <div className="text-[12.5px] text-muted">{r.phone}</div>
                <div className="mt-1.5 font-display text-[14px] font-bold text-plum">
                  {r.score} / {r.max_score}
                  <span className="ml-2 font-normal text-muted">{secs(r.answer_ms)}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-[#8A4A20]">
            Points, then fastest answering time, then earliest submission. Students never see the
            times, so their board can differ from this order.
          </p>
        </section>
      ) : null}

      {/* -------------------------------- tabs ----------------------------- */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(
          [
            ["run", "Run the quiz"],
            ["results", `Results (${data.results.length})`],
            ["analysis", `Question analysis (${data.analysis.length})`],
            ["pending", `Did not finish (${data.notFinished.length})`],
            ["settings", "Settings"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={[
              "rounded-[11px] px-3.5 py-2 font-display text-[13.5px] font-medium transition",
              tab === key
                ? "bg-plum text-white"
                : "border-[1.5px] border-ink/10 bg-white text-plum hover:bg-petal",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ------------------------------ results ---------------------------- */}
      {tab === "results" ? (
        <div className="panel">
          {data.results.length === 0 ? (
            <Empty>
              Nothing submitted yet. The student link is{" "}
              <code className="rounded bg-petal px-1.5 py-0.5 text-plum">{shareUrl}</code>
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-12">Rank</th>
                    <th>Name</th>
                    <th>Mobile</th>
                    <th>Email</th>
                    {s.collect_class ? <th>Class</th> : null}
                    <th className="text-right">Score</th>
                    <th className="text-right">Accuracy</th>
                    <th className="text-right">Answer time</th>
                    <th className="text-right">Total time</th>
                    <th>Submitted</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r) => (
                    <tr key={r.id}>
                      <td className="font-display font-medium tabular-nums">
                        {r.rank <= 3 ? MEDALS[r.rank - 1] : r.rank}
                      </td>
                      <td className="font-semibold">
                        {r.name}
                        {r.repeat ? (
                          <Chip tone="warn">
                            try {r.attempt_no}/{r.attempts_by_student}
                          </Chip>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap tabular-nums">
                        <a href={`tel:${r.phone}`} className="hover:underline">
                          {r.phone}
                        </a>
                      </td>
                      <td className="max-w-[190px] truncate text-[13px]">
                        {r.email ? (
                          <a href={`mailto:${r.email}`} className="hover:underline">
                            {r.email}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      {s.collect_class ? <td className="text-[13px]">{r.class_or_year || "—"}</td> : null}
                      <td className="text-right font-display font-bold tabular-nums text-plum">
                        {r.score}
                        <span className="text-[12px] font-normal text-muted">/{r.max_score}</span>
                      </td>
                      <td className="text-right tabular-nums">{r.accuracy}%</td>
                      <td className="text-right tabular-nums">{secs(r.answer_ms)}</td>
                      <td className="text-right tabular-nums text-muted">{secs(r.elapsed_ms)}</td>
                      <td className="whitespace-nowrap text-[12.5px] text-muted">
                        {when(r.submitted_at)}
                      </td>
                      <td className="text-right">
                        <button className="linkish" onClick={() => setOpenAttempt(r)}>
                          Answers
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {/* ----------------------------- analysis ---------------------------- */}
      {tab === "analysis" ? (
        <div className="panel">
          {data.analysis.length === 0 ? (
            <Empty>No answers recorded yet.</Empty>
          ) : (
            <>
              <p className="hint mb-3">Hardest questions first.</p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Question</th>
                      <th>Correct answer</th>
                      <th className="text-right">Asked</th>
                      <th className="text-right">Right</th>
                      <th className="w-40">% correct</th>
                      <th className="text-right">Avg time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.analysis.map((a, i) => (
                      <tr key={i}>
                        <td className="max-w-[420px] text-[13.5px] leading-snug">
                          <QuestionText text={a.question_text} />
                        </td>
                        <td className="max-w-[240px] text-[13px] leading-snug text-moss">
                          {a.correct_text}
                        </td>
                        <td className="text-right tabular-nums">{a.asked}</td>
                        <td className="text-right tabular-nums">{a.got_right}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink/10">
                              <div
                                className={[
                                  "h-full rounded-full",
                                  a.pct_correct >= 70
                                    ? "bg-moss"
                                    : a.pct_correct >= 40
                                      ? "bg-apricot"
                                      : "bg-coral",
                                ].join(" ")}
                                style={{ width: `${Math.max(2, a.pct_correct)}%` }}
                              />
                            </div>
                            <span className="w-11 text-right font-display text-[12.5px] font-medium tabular-nums">
                              {a.pct_correct}%
                            </span>
                          </div>
                        </td>
                        <td className="text-right tabular-nums text-muted">{secs(a.avg_ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* -------------------------------- run ------------------------------ */}
      {tab === "run" ? (
        <RunPanel
          headerLink={
            <Link href={`/admin/organizations/${s.slug}/dashboard`} className="linkish">
              Fullscreen
            </Link>
          }
          summary={data.summary}
          top={data.results.slice(0, 5)}
          live={live}
          ended={ended}
          leftMs={leftMs}
          canWrite={canWrite}
          onStart={() => void startRound()}
          onClose={() => void toggleOpen()}
          shareUrl={shareUrl}
        />
      ) : null}

      {/* ------------------------------ pending ---------------------------- */}
      {tab === "pending" ? (
        <div className="panel">
          {data.notFinished.length === 0 ? (
            <Empty>Everyone who registered finished the quiz.</Empty>
          ) : (
            <>
              <p className="hint mb-3">Registered but never submitted.</p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Mobile</th>
                      <th>Email</th>
                      <th className="text-right">Started</th>
                      <th>Registered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.notFinished.map((p) => (
                      <tr key={p.id}>
                        <td className="font-semibold">{p.name}</td>
                        <td className="tabular-nums">{p.phone}</td>
                        <td className="max-w-[220px] truncate text-[13px]">{p.email || "—"}</td>
                        <td className="text-right tabular-nums">{p.attempts}</td>
                        <td className="whitespace-nowrap text-[12.5px] text-muted">
                          {when(p.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* ----------------------------- settings ---------------------------- */}
      {tab === "settings" ? (
        <div className="panel">
          <div className="mb-5 rounded-[14px] bg-petal px-4 py-3.5">
            <p className="mb-1 font-display text-[13px] font-medium uppercase tracking-[0.1em] text-plum-soft">
              Student link
            </p>
            <p className="break-all font-mono text-[13.5px] text-plum">{shareUrl}</p>
            <p className="mt-1.5 text-[12.5px] text-muted">
              Staff results for this organization also live at{" "}
              <span className="font-mono">/s/{s.slug}/admin</span>.
            </p>
          </div>

          {draft ? (
            <OrganizationForm
              draft={draft}
              setDraft={setDraft}
              sets={sets}
              organizationId={organizationId}
              readOnly={!canWrite}
              onCancel={() => void load()}
              onSaved={() => {
                setNotice("Settings saved.");
                void load();
              }}
            />
          ) : null}

          {canWrite ? (
            <div className="mt-7 rounded-xl2 border-[1.5px] border-coral/35 bg-coral/[0.05] p-4">
              <h3 className="mb-1.5 font-display text-[15px] font-medium text-coral">
                Clearing and deleting
              </h3>
              <p className="mb-3.5 text-[13.5px] leading-relaxed text-[#6B4046]">
                Nothing is erased: deleted records move to the Deleted page and can be put
                back. Download the Excel sheet anyway if you want a copy on your machine.
              </p>
              <div className="flex flex-wrap gap-2.5">
                <button className="btn-danger btn-sm" onClick={() => setDanger("entries")}>
                  Clear all entries
                </button>
                <button className="btn-ghost btn-sm" onClick={() => setDanger("all")}>
                  Delete this organization
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {!compact ? (
        <p className="mt-4">
          <Link href="/admin/organizations" className="linkish">
            ← All organizations
          </Link>
        </p>
      ) : null}

      {openAttempt ? (
        <AttemptModal attempt={openAttempt} onClose={() => setOpenAttempt(null)} />
      ) : null}

      {danger ? (
        <DangerModal
          mode={danger}
          organization={s}
          count={data.summary.registered}
          onClose={() => setDanger(null)}
          onDone={(msg, deletedEvent) => {
            setDanger(null);
            setNotice(msg);
            if (deletedEvent) window.location.href = "/admin/organizations";
            else void load();
          }}
        />
      ) : null}
    </>
  );
}

/* --------------------------- one answer sheet ---------------------------- */

function AttemptModal({ attempt, onClose }: { attempt: Result; onClose: () => void }) {
  const [answers, setAnswers] = useState<
    | {
        position: number;
        question_text: string;
        chosen_text: string;
        correct_text: string;
        is_correct: boolean;
        ms: number;
      }[]
    | null
  >(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<{ answers: typeof answers }>(`/api/admin/attempts/${attempt.id}`)
      .then((d) => setAnswers(d.answers ?? []))
      .catch((e) => setError(errText(e)));
  }, [attempt.id]);

  return (
    <Modal title={`${attempt.name} — ${attempt.score}/${attempt.max_score}`} onClose={onClose} wide>
      <p className="mb-4 text-[13.5px] text-muted">
        {attempt.phone}
        {attempt.email ? ` · ${attempt.email}` : ""} · rank {attempt.rank} ·{" "}
        {secs(attempt.answer_ms)} answering · submitted {when(attempt.submitted_at)}
      </p>

      <Notice tone="warn">{error}</Notice>
      {answers === null && !error ? <Spinner /> : null}

      <ol className="space-y-2.5">
        {answers?.map((a) => (
          <li
            key={a.position}
            className={[
              "rounded-[14px] border-[1.5px] p-3.5",
              a.is_correct ? "border-moss/35 bg-moss/[0.06]" : "border-coral/35 bg-coral/[0.05]",
            ].join(" ")}
          >
            <div className="mb-1.5 flex items-start justify-between gap-3">
              <QuestionText
                text={a.question_text}
                prefix={`${a.position + 1}.`}
                className="font-display text-[14.5px] font-medium leading-snug text-ink"
              />
              <span className="shrink-0 whitespace-nowrap text-[12px] tabular-nums text-muted">
                {secs(a.ms)}
              </span>
            </div>
            <p className="text-[13.5px] leading-relaxed">
              <span className={a.is_correct ? "text-moss" : "text-coral"}>
                {a.is_correct ? "✓" : "✗"}
              </span>{" "}
              Answered: <b>{a.chosen_text || "no answer"}</b>
            </p>
            {!a.is_correct ? (
              <p className="text-[13.5px] leading-relaxed text-moss">
                Correct: <b>{a.correct_text}</b>
              </p>
            ) : null}
          </li>
        ))}
      </ol>

      {answers?.length === 0 ? <Empty>No answers recorded for this attempt.</Empty> : null}
    </Modal>
  );
}

/* ---------------------- clear entries / delete organization -------------------- */

function DangerModal({
  mode,
  organization,
  count,
  onClose,
  onDone,
}: {
  mode: "entries" | "all";
  organization: Organization;
  count: number;
  onClose: () => void;
  onDone: (message: string, deletedEvent: boolean) => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ removed: number; deletedEvent: boolean }>(
        `/api/admin/organizations/${organization.id}?mode=${mode}&confirm=${encodeURIComponent(confirm)}`,
        { method: "DELETE" },
      );
      onDone(
        res.deletedEvent
          ? `Deleted “${organization.name}” and ${res.removed} entries.`
          : `Cleared ${res.removed} entries. The code ${organization.slug} still works.`,
        res.deletedEvent,
      );
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={mode === "all" ? "Delete this organization" : "Clear all entries"}
      onClose={onClose}
    >
      <p className="mb-3 text-[14.5px] leading-relaxed text-[#463359]">
        {mode === "all" ? (
          <>
            This removes the organization, its code <b>{organization.slug}</b>, and all {count} registered
            students with their answers. The link will stop working.
          </>
        ) : (
          <>
            This removes all {count} registered students and their answers. The organization and its code{" "}
            <b>{organization.slug}</b> stay.
          </>
        )}
      </p>
      <p className="mb-4 text-[14px] font-bold text-coral">
        This can be undone. Everything removed here stays in the database and can be
        restored from the Deleted page.
      </p>

      <Field label={`Type the code “${organization.slug}” to confirm`}>
        <input
          className="input-sm font-mono"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="off"
        />
      </Field>

      <Notice tone="warn">{error}</Notice>

      <div className="mt-4 flex flex-wrap gap-2.5">
        <button
          className="btn-danger btn-sm"
          onClick={() => void go()}
          disabled={busy || confirm.trim().toLowerCase() !== organization.slug.toLowerCase()}
        >
          {busy ? "Working…" : mode === "all" ? "Delete organization" : "Clear entries"}
        </button>
        <button className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
