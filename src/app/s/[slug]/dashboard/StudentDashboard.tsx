"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, errText } from "@/lib/client";
import { Loading, PrizeNote } from "@/components/Stage";
import { QuestionText } from "@/components/QuestionText";

type Dash = {
  student: { name: string; phone: string; email: string; classOrYear: string; registeredAt: string };
  organization: {
    slug: string;
    name: string;
    isOpen: boolean;
    showLeaderboard: boolean;
    prizeNote: string;
  };
  attempts: {
    attemptId: string;
    status: string;
    score: number | null;
    maxScore: number;
    correctCount: number | null;
    questionCount: number;
    answerMs: number;
    elapsedMs: number;
    startedAt: string;
    submittedAt: string | null;
  }[];
  rank: { position: number; of: number } | null;
  leaderboard: { rank: number; name: string; score: number }[];
  review: {
    position: number;
    question: string;
    chosen: string;
    correct: string;
    points: number;
    maxPoints: number;
    isCorrect: boolean;
    ms: number;
  }[];
  reviewUnlocked: boolean;
};

const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

/**
 * A student's own view. It tries the existing session cookie first, so anybody
 * who just played lands straight on their result; only a returning visitor on a
 * fresh browser has to type their name and number again.
 */
export function StudentDashboard({ slug }: { slug: string }) {
  const [data, setData] = useState<Dash | null>(null);
  const [checking, setChecking] = useState(true);
  const [form, setForm] = useState({ name: "", phone: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Dash>("/api/me")
      .then((d) => {
        // A stale cookie can belong to a different event than the one requested.
        if (d.organization.slug === slug) setData(d);
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [slug]);

  const signIn = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError("");
      if (!/^[6-9]\d{9}$/.test(form.phone))
        return setError("Enter the 10-digit mobile number you registered with.");
      if (form.name.trim().length < 2) return setError("Enter your name.");

      setBusy(true);
      try {
        setData(await api<Dash>("/api/me", { body: { slug, ...form } }));
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(false);
      }
    },
    [form, slug],
  );

  async function signOut() {
    await api("/api/me", { method: "DELETE" }).catch(() => {});
    setData(null);
    setForm({ name: "", phone: "" });
  }

  if (checking) return <Loading label="Checking…" />;

  /* ------------------------------- sign in ------------------------------- */
  if (!data)
    return (
      <form onSubmit={signIn} noValidate>
        <h1 className="mb-1 font-display text-[28px] font-bold leading-tight text-plum">
          Your dashboard
        </h1>
        <p className="mb-4 text-[15.5px] leading-relaxed text-[#463359]">
          Sign in with the details you played with.
        </p>

        <label className="field" htmlFor="dn">
          Full name
        </label>
        <input
          id="dn"
          className="input"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          autoComplete="name"
          disabled={busy}
        />

        <label className="field" htmlFor="dp">
          Mobile number
        </label>
        <input
          id="dp"
          className="input"
          type="tel"
          inputMode="numeric"
          maxLength={10}
          value={form.phone}
          onChange={(e) =>
            setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })
          }
          autoComplete="tel"
          placeholder="10-digit number"
          disabled={busy}
        />

        <p className="err mt-2.5" role="alert">
          {error}
        </p>

        <button type="submit" className="btn-primary mt-4" disabled={busy}>
          {busy ? "Checking…" : "Open my dashboard"}
        </button>
        <Link href={`/s/${slug}`} className="btn-ghost mt-2.5">
          Back to the quiz
        </Link>
      </form>
    );

  /* ------------------------------ dashboard ------------------------------ */
  const best = data.attempts.find((a) => a.status === "completed");
  const first = data.student.name.split(" ")[0];

  return (
    <>
      <p className="eyebrow mb-1 text-plum-soft">Your dashboard</p>
      <h1 className="mb-4 font-display text-[28px] font-bold leading-tight text-plum">
        Hello, {first}
      </h1>

      {best ? (
        <div className="mb-4 grid grid-cols-3 gap-2.5">
          <Tile
            label="Score"
            value={best.score !== null ? `${best.score}` : "—"}
            sub={best.score !== null ? `of ${best.maxScore}` : "hidden"}
          />
          <Tile
            label="Rank"
            value={data.rank ? `${data.rank.position}` : "—"}
            sub={data.rank ? `of ${data.rank.of}` : "not ranked"}
          />
          <Tile label="Answer time" value={secs(best.answerMs)} sub="total" />
        </div>
      ) : (
        <p className="mb-4 text-[15.5px] leading-relaxed text-[#463359]">
          You are registered for {data.organization.name}, but have not finished the quiz.
        </p>
      )}

      <PrizeNote text={data.organization.prizeNote} />

      {/* ----------------------------- attempts ---------------------------- */}
      {data.attempts.length > 1 ? (
        <>
          <h2 className="mb-2 mt-5 font-display text-[17px] font-medium text-plum">Your attempts</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Score</th>
                  <th className="text-right">Time</th>
                </tr>
              </thead>
              <tbody>
                {data.attempts.map((a) => (
                  <tr key={a.attemptId}>
                    <td>{when(a.submittedAt ?? a.startedAt)}</td>
                    <td className="font-semibold">
                      {a.status === "completed"
                        ? a.score !== null
                          ? `${a.score} / ${a.maxScore}`
                          : "recorded"
                        : "not finished"}
                    </td>
                    <td className="text-right tabular-nums">{secs(a.answerMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {/* ---------------------------- leaderboard -------------------------- */}
      {data.organization.showLeaderboard && data.leaderboard.length ? (
        <>
          <h2 className="mb-2 mt-5 font-display text-[17px] font-medium text-plum">Top 10</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-10">Rank</th>
                  <th>Name</th>
                  <th className="text-right">Points</th>
                </tr>
              </thead>
              <tbody>
                {data.leaderboard.map((r) => (
                  <tr
                    key={r.rank}
                    className={data.rank?.position === r.rank ? "bg-apricot/15" : ""}
                  >
                    <td className="font-display font-medium tabular-nums">
                      {r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : r.rank}
                    </td>
                    <td className="font-semibold">{r.name}</td>
                    <td className="text-right font-display font-medium tabular-nums">{r.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint mt-3">
            Ties are broken by answering speed, so the announced winner can differ from this order.
          </p>
        </>
      ) : null}

      {/* ------------------------------ review ----------------------------- */}
      {data.reviewUnlocked && data.review.length ? (
        <>
          <h2 className="mb-2 mt-5 font-display text-[17px] font-medium text-plum">
            Your answers
          </h2>
          <ol className="space-y-2.5">
            {data.review.map((r) => (
              <li
                key={r.position}
                className={[
                  "rounded-2xl border-[1.5px] p-3.5",
                  r.isCorrect ? "border-moss/35 bg-moss/[0.07]" : "border-coral/35 bg-coral/[0.06]",
                ].join(" ")}
              >
                <div className="mb-1.5 flex items-start justify-between gap-3">
                  <QuestionText
                    text={r.question}
                    prefix={`${r.position + 1}.`}
                    className="font-display text-[15px] font-medium leading-snug text-ink"
                  />
                  {r.maxPoints > 0 ? (
                    <span
                      className={[
                        "shrink-0 whitespace-nowrap rounded-full px-2.5 py-[3px] font-display text-[11.5px] font-bold tabular-nums",
                        r.isCorrect ? "bg-moss/15 text-moss" : "bg-ink/[0.06] text-muted",
                      ].join(" ")}
                    >
                      {r.points}/{r.maxPoints}
                    </span>
                  ) : null}
                </div>
                <p className="text-[14px] leading-relaxed text-[#463359]">
                  <span className={r.isCorrect ? "text-moss" : "text-coral"}>
                    {r.isCorrect ? "✓" : "✗"}
                  </span>{" "}
                  You answered: <b>{r.chosen || "no answer"}</b>
                </p>
                {!r.isCorrect ? (
                  <p className="text-[14px] leading-relaxed text-moss">
                    {/* A "select all that apply" question lists its options separated
                        by " | ", so the label has to read as a plural. */}
                    Correct answer{r.correct.includes(" | ") ? "s" : ""}: <b>{r.correct}</b>
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : best ? (
        <p className="hint mt-5">
          {data.reviewUnlocked
            ? "No answer sheet was recorded for this attempt."
            : "Your answers unlock when the quiz closes."}
        </p>
      ) : null}

      <div className="mt-5 flex flex-col gap-2.5">
        {!best && data.organization.isOpen ? (
          <Link href={`/s/${slug}`} className="btn-primary">
            Take the quiz
          </Link>
        ) : null}
        <button className="btn-ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl bg-petal px-3 py-3.5 text-center">
      <div className="font-display text-[24px] font-bold leading-none tabular-nums text-plum">
        {value}
      </div>
      <div className="mt-1 text-[11px] font-bold uppercase tracking-wider text-plum-soft">
        {label}
      </div>
      <div className="text-[11px] text-muted">{sub}</div>
    </div>
  );
}
