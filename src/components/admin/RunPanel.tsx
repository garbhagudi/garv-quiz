"use client";

import type { ReactNode } from "react";
import { Notice, Empty, MEDALS } from "./Ui";
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
  canWrite,
  onStart,
  onClose,
  shareUrl,
  headerLink,
}: {
  summary: RunSummary;
  top: RunResult[];
  live: boolean;
  ended: boolean;
  leftMs: number | null;
  canWrite: boolean;
  onStart: () => void;
  onClose: () => void;
  shareUrl: string;
  /** Optional way out — the tab uses it to point at the standalone screen. */
  headerLink?: ReactNode;
}) {
  const waiting = summary.answering;

  return (
    <div className="space-y-4">
      {/* ---- the clock, and the two buttons ---- */}
      <div className="panel text-center">
        <p className="font-display text-[11px] font-medium uppercase tracking-[0.16em] text-plum-soft">
          {live ? (leftMs === null ? "Entries are open" : "Round in progress") : ended ? "Round over" : "Entries are closed"}
        </p>

        <div
          className={[
            "mt-1.5 font-display font-bold tabular-nums leading-none",
            leftMs !== null && live ? "text-[54px]" : "text-[34px]",
            live ? (leftMs !== null && leftMs <= 60_000 ? "text-coral" : "text-plum") : "text-muted",
          ].join(" ")}
          role={leftMs !== null && live ? "timer" : undefined}
        >
          {live ? (leftMs === null ? "No time limit" : fmtLeft(leftMs)) : ended ? "0:00" : "—"}
        </div>

        {live && leftMs === null ? (
          <p className="mt-1.5 text-[12.5px] text-muted">
            This question set has no time limit, so close the entries yourself when the room is done.
          </p>
        ) : null}

        {canWrite ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2.5">
            {live && leftMs !== null ? null : (
              <button className="btn-primary btn-sm" onClick={onStart}>
                {ended ? "Start another round" : "Start round"}
              </button>
            )}
            {live ? (
              <button className="btn-ghost btn-sm" onClick={onClose}>
                Close entries now
              </button>
            ) : null}
          </div>
        ) : null}

        <p className="mt-3.5 text-[12.5px] text-muted">
          Join at <code className="rounded bg-petal px-1.5 py-0.5 text-plum">{shareUrl}</code>
        </p>
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
