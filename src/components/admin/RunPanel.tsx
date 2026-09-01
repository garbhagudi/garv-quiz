"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Notice, Empty, MEDALS } from "./Ui";
import { QrCode } from "./QrCode";
import type { Organization } from "@/lib/types";

/* -------------------------------- shapes --------------------------------- */

/** Only the parts of a result the run screen draws. */
export type RunResult = {
  id: number;
  rank: number;
  name: string;
  score: number;
  max_score: number;
};

/** Only the parts of the summary the run screen draws. */
export type RunSummary = {
  registered: number;
  completed: number;
  answering: number;
};

/** m:ss for a countdown, h:mm:ss once a round runs longer than an hour. */
export function fmtLeft(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const ss = String(t % 60).padStart(2, "0");
  const mm = Math.floor(t / 60) % 60;
  const hh = Math.floor(t / 3600);
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/**
 * The screen for the day itself, not for reading afterwards: start the round,
 * watch the clock, watch the room finish, close it by hand if you need to.
 *
 * Deliberately narrow. Everything here answers one of four questions a host
 * actually asks while standing in front of a room — how long is left, how many
 * have finished, how many are still going, and who is winning. The full results
 * table, the per-question analysis and the settings are all one tab away and
 * none of them belong on this one.
 */
export function RunPanel({
  summary,
  top,
  live,
  ended,
  leftMs,
  timeLimitSeconds,
  showStart,
  showOpenDoors,
  canWrite,
  onStart,
  onOpenDoors,
  onClose,
  shareUrl,
  headerLink,
}: {
  summary: RunSummary;
  top: RunResult[];
  live: boolean;
  ended: boolean;
  leftMs: number | null;
  /** The set's whole-quiz limit; null means the set is untimed. */
  timeLimitSeconds: number | null;
  /** Both decided by canStartRound / canOpenWaitingRoom in @/lib/eventWindow. */
  showStart: boolean;
  showOpenDoors: boolean;
  canWrite: boolean;
  onStart: () => void;
  /** Open the waiting room without starting the clock. Timed events only. */
  onOpenDoors: () => void;
  onClose: () => void;
  shareUrl: string;
  /** Optional way out — the tab uses it to point at the standalone screen. */
  headerLink?: ReactNode;
}) {
  const waiting = summary.answering;

  /* `leftMs === null` covers two different events: one whose set is untimed,
     and a timed one nobody has started yet. Only the set's own limit tells them
     apart, which is why `showStart` and `showOpenDoors` are worked out by the
     caller from the shared predicates in @/lib/eventWindow rather than guessed
     at from `leftMs` here. This screen exists twice, and every time that logic
     was written inline in both copies the two drifted.

     The waiting room - doors open, clock not running - is what is left when a
     timed event is live with nothing counting down. Registering there is the
     point: typing a name and a mobile number is not what a five-minute round is
     for, so the host fills the room first and starts when it is full. */
  const timed = timeLimitSeconds !== null;
  const counting = live && leftMs !== null;
  const lobby = timed && live && !counting;

  return (
    <div className="space-y-4">
      {/* ---- the clock, and the two buttons ---- */}
      <div className="panel text-center">
        <p className="font-display text-[11px] font-medium uppercase tracking-[0.16em] text-plum-soft">
          {live
            ? counting
              ? "Round in progress"
              : lobby
                ? "Waiting room open"
                : "Entries are open"
            : ended
              ? "Round over"
              : "Entries are closed"}
        </p>

        <div
          className={[
            "mt-1.5 font-display font-bold tabular-nums leading-none",
            leftMs !== null && live ? "text-[54px]" : "text-[34px]",
            live ? (leftMs !== null && leftMs <= 60_000 ? "text-coral" : "text-plum") : "text-muted",
          ].join(" ")}
          role={leftMs !== null && live ? "timer" : undefined}
        >
          {live
            ? counting
              ? fmtLeft(leftMs)
              : lobby
                ? "Ready"
                : "No time limit"
            : ended
              ? "0:00"
              : "—"}
        </div>

        {live && leftMs === null ? (
          <p className="mt-1.5 text-[12.5px] text-muted">
            {lobby
              ? `${summary.registered} registered and waiting. Start round counts them in, then gives everyone ${fmtLeft(timeLimitSeconds * 1000)} to answer.`
              : "This question set has no time limit, so close the entries yourself when the room is done."}
          </p>
        ) : null}

        {canWrite ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2.5">
            {showOpenDoors ? (
              <button className="btn-ghost btn-sm" onClick={onOpenDoors}>
                Open waiting room
              </button>
            ) : null}
            {showStart ? (
              <button className="btn-primary btn-sm" onClick={onStart}>
                {ended ? "Start another round" : "Start round"}
              </button>
            ) : null}
            {live ? (
              <button className="btn-ghost btn-sm" onClick={onClose}>
                Close entries now
              </button>
            ) : null}
          </div>
        ) : null}

        {showOpenDoors ? (
          <p className="mt-2.5 text-[12.5px] text-muted">
            Open the waiting room first to let the room register while you talk — then Start round
            is just the clock.
          </p>
        ) : null}

        <JoinBlock shareUrl={shareUrl} />
        {headerLink ? <div className="mt-2">{headerLink}</div> : null}
      </div>

      {/* ---- the three numbers that matter while it runs ---- */}
      <div className="grid grid-cols-3 gap-2.5">
        <RunTile value={summary.registered} label="Registered" />
        <RunTile
          value={waiting}
          label="Still answering"
          tone={waiting ? "warn" : "plain"}
        />
        <RunTile value={summary.completed} label="Submitted" tone="good" />
      </div>

      {/* ---- the one thing worth saying after the clock runs out ---- */}
      {ended || (!live && summary.completed > 0) ? (
        <Notice tone={waiting ? "warn" : "good"}>
          {waiting
            ? `The round is over, but ${waiting} ${waiting === 1 ? "student is" : "students are"} still answering — their own clock is still running, and their answers will still count. Wait for this to reach zero before announcing anything.`
            : `Everybody who started has submitted. ${summary.completed} ${summary.completed === 1 ? "result is" : "results are"} in.`}
        </Notice>
      ) : null}

      {/* ---- who is winning, filling in as they submit ---- */}
      <div className="panel">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h3 className="font-display text-[15px] font-medium text-plum">Leading</h3>
          <span className="text-[12px] text-muted">refreshes every few seconds</span>
        </div>
        {top.length === 0 ? (
          <Empty>Nobody has submitted yet.</Empty>
        ) : (
          <ol className="space-y-1.5">
            {top.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-[12px] bg-petal/60 px-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="font-display text-[15px] font-medium tabular-nums text-plum-soft">
                    {r.rank <= 3 ? MEDALS[r.rank - 1] : r.rank}
                  </span>
                  <span className="truncate font-semibold text-ink">{r.name}</span>
                </span>
                <span className="whitespace-nowrap font-display font-medium tabular-nums text-plum">
                  {r.score}
                  <span className="text-[12px] font-normal text-muted"> / {r.max_score}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/**
 * How the room gets in: the code to scan and the address to type, together.
 *
 * Both, not one or the other. A phone with a camera scans; a laptop at the back
 * types. The code enlarges to fill the screen because the way this actually
 * gets used is projected, and a 104px square is unreadable past the third row.
 */
function JoinBlock({ shareUrl }: { shareUrl: string }) {
  const [big, setBig] = useState(false);

  // Escape closes the projected view, same as every other overlay here.
  useEffect(() => {
    if (!big) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBig(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [big]);

  return (
    <>
      <div className="mt-4 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => setBig(true)}
          className="shrink-0 rounded-[10px] border border-ink/10 p-1.5 transition hover:border-plum/40 hover:bg-petal"
          title="Show the code big enough to project"
        >
          <QrCode value={shareUrl} className="h-[92px] w-[92px]" />
        </button>

        <div className="min-w-0 text-left">
          <p className="font-display text-[10.5px] font-medium uppercase tracking-[0.14em] text-plum-soft">
            Join at
          </p>
          <code className="mt-0.5 block truncate rounded bg-petal px-1.5 py-0.5 text-[12.5px] text-plum">
            {shareUrl}
          </code>
          <p className="mt-1 text-[12px] text-muted">Scan the code, or type the address.</p>
        </div>
      </div>

      {big ? (
        <div
          className="fixed inset-0 z-50 flex cursor-zoom-out flex-col items-center justify-center gap-6 bg-white p-6"
          onClick={() => setBig(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Join code, enlarged"
        >
          {/* Sized off the shorter side so it fills a projector in either
              orientation without ever overflowing. */}
          <QrCode value={shareUrl} className="h-[min(70vh,70vw)] w-[min(70vh,70vw)]" />
          <p className="text-center font-display text-[clamp(18px,4vw,40px)] font-bold tracking-tight text-plum">
            {shareUrl}
          </p>
          <p className="text-[13px] text-muted">Click anywhere, or press Escape, to close.</p>
        </div>
      ) : null}
    </>
  );
}

/** A big number for the run screen — larger and plainer than the desk tiles. */
const RunTile = ({
  value,
  label,
  tone = "plain",
}: {
  value: number;
  label: string;
  tone?: "plain" | "good" | "warn";
}) => (
  <div className="rounded-xl2 border border-ink/10 bg-white px-3 py-3.5 text-center">
    <div
      className={[
        "font-display text-[30px] font-bold leading-none tabular-nums",
        tone === "good" ? "text-moss" : tone === "warn" ? "text-coral" : "text-plum",
      ].join(" ")}
    >
      {value}
    </div>
    <div className="mt-1.5 font-display text-[10.5px] font-medium uppercase tracking-[0.1em] text-plum-soft">
      {label}
    </div>
  </div>
);
