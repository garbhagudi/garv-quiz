"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiRetry, errText, ApiCallError } from "@/lib/client";
import { Dots, Loading, PrizeNote } from "@/components/Stage";
import { QuestionText } from "@/components/QuestionText";

/* -------------------------------- types ---------------------------------- */

type ClientQuestion = {
  p: number;
  qid: number | null;
  text: string;
  opts: string[];
  pts: number;
  /** Several options are correct: ask for a set, not a single tap. */
  multi?: boolean;
  /** A picture to show above the question, and what it shows. */
  img?: string;
  alt?: string;
};
type Answer = { position: number; optionIndexes: number[]; ms: number };

type StartResponse = {
  attemptId: string;
  questions: ClientQuestion[];
  /** Whole-quiz limit from the question set; null means untimed. */
  timeLimitSeconds: number | null;
  student: { name: string };
};

type SubmitResponse = {
  score: number | null;
  maxScore: number;
  correctCount: number | null;
  questionCount: number;
  showLeaderboard: boolean;
  alreadySubmitted?: boolean;
};

type BoardResponse = {
  count: number;
  outOf: number;
  you: { rank: number; score: number; maxScore: number; name: string } | null;
  top: { rank: number; name: string; score: number; maxScore: number }[];
};

type Screen = "register" | "instructions" | "quiz" | "saving" | "saveFailed" | "done" | "board";

export type QuizFlowProps = {
  slug: string;
  organizationName: string;
  isOpen: boolean;
  hasQuestions: boolean;
  questionCount: number;
  played: number;
  /** Whole-quiz limit from the set, so the landing page can state it. */
  timeLimitSeconds: number | null;
  requireEmail: boolean;
  collectClass: boolean;
  showLeaderboard: boolean;
  prizeNote: string;
};

const fmtSeconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

/** m:ss, for a countdown — rounded up so it only shows 0:00 when time is up. */
const fmtClock = (ms: number) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/* ================================ flow =================================== */

export function QuizFlow(props: QuizFlowProps) {
  const [screen, setScreen] = useState<Screen>("register");

  const [form, setForm] = useState({ name: "", phone: "", email: "", classOrYear: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [attemptId, setAttemptId] = useState("");
  const [questions, setQuestions] = useState<ClientQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const answers = useRef<Answer[]>([]);
  const runStart = useRef(0);

  // The whole-quiz limit, if the set carries one. `deadline` is a wall-clock
  // instant rather than a countdown value, so the clock cannot be slowed down
  // by a backgrounded tab dropping its timers.
  const [timeLimitSeconds, setTimeLimitSeconds] = useState<number | null>(null);
  const deadline = useRef(0);
  const [remainingMs, setRemainingMs] = useState(0);

  const [result, setResult] = useState<SubmitResponse | null>(null);

  /* ------------------------------ register ------------------------------- */

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (form.name.trim().length < 3) return setError("Enter your full name.");
    if (!/^[6-9]\d{9}$/.test(form.phone)) return setError("Enter a valid 10-digit mobile number.");
    if (props.requireEmail && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(form.email))
      return setError("Enter a valid email address.");

    setBusy(true);
    try {
      const data = await api<StartResponse>("/api/quiz/start", {
        body: { slug: props.slug, ...form },
      });
      answers.current = [];
      setAttemptId(data.attemptId);
      setQuestions(data.questions);
      setTimeLimitSeconds(data.timeLimitSeconds ?? null);
      setIndex(0);
      setScreen("instructions");
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  /* -------------------------------- submit ------------------------------- */

  const submit = useCallback(async () => {
    setScreen("saving");
    setError("");
    try {
      const data = await apiRetry<SubmitResponse>("/api/quiz/submit", {
        body: {
          attemptId,
          answers: answers.current,
          elapsedMs: Date.now() - runStart.current,
        },
      });
      setResult(data);
      setScreen("done");
    } catch (err) {
      setError(errText(err));
      setScreen("saveFailed");
    }
  }, [attemptId]);

  /**
   * Leaving the rules screen is where the run really begins, so the wall clock
   * starts here rather than at registration — otherwise a student who reads the
   * rules carefully would show a worse total time for it. Per-question timing
   * is unaffected either way: it starts when a question renders.
   */
  function begin() {
    runStart.current = Date.now();
    if (timeLimitSeconds) {
      deadline.current = Date.now() + timeLimitSeconds * 1000;
      setRemainingMs(timeLimitSeconds * 1000);
    }
    setScreen("quiz");
  }

  /**
   * The whole-quiz countdown. One interval for the run rather than one per
   * question, so moving between questions never restarts it, and it is read
   * from the deadline each tick so a phone that slept catches up rather than
   * losing the time it was asleep for.
   *
   * At zero the quiz submits itself with whatever has been answered — a student
   * who runs out still gets a score for what they did.
   */
  useEffect(() => {
    if (screen !== "quiz" || !deadline.current) return;
    const tick = setInterval(() => {
      const left = deadline.current - Date.now();
      setRemainingMs(Math.max(0, left));
      if (left <= 0) {
        clearInterval(tick);
        void submit();
      }
    }, 250);
    return () => clearInterval(tick);
  }, [screen, submit]);

  function answer(optionIndexes: number[], ms: number) {
    answers.current.push({ position: questions[index].p, optionIndexes, ms });
    if (index + 1 < questions.length) setIndex(index + 1);
    else void submit();
  }

  /* ------------------------------- screens ------------------------------- */

  if (!props.hasQuestions)
    return (
      <Closed
        title="Not ready yet"
        body="This event has no questions set up. Let the team know."
        slug={props.slug}
      />
    );

  if (!props.isOpen && screen === "register")
    return (
      <Closed
        title="This quiz has closed"
        body="If you already played, your score and rank are on your dashboard."
        slug={props.slug}
      />
    );

  if (screen === "register")
    return (
      <RegisterForm
        {...props}
        form={form}
        setForm={setForm}
        error={error}
        busy={busy}
        onSubmit={start}
      />
    );

  if (screen === "instructions")
    return (
      <Instructions
        questions={questions}
        name={form.name}
        timeLimitSeconds={timeLimitSeconds}
        showLeaderboard={props.showLeaderboard}
        prizeNote={props.prizeNote}
        onBegin={begin}
      />
    );

  if (screen === "quiz")
    return (
      <Question
        key={index}
        question={questions[index]}
        index={index}
        total={questions.length}
        remainingMs={timeLimitSeconds ? remainingMs : null}
        onAnswer={answer}
      />
    );

  if (screen === "saving") return <Loading label="Saving your answers…" />;

  if (screen === "saveFailed")
    return (
      <>
        <h1 className="mb-3 font-display text-[28px] font-bold leading-tight text-plum">
          Not saved yet
        </h1>
        <p className="err mb-3" role="alert">
          {error}
        </p>
        <p className="mb-4 text-[15.5px] leading-relaxed text-[#463359]">
          Your answers are still here. Try again, and show this screen to the team if it keeps
          failing.
        </p>
        <button className="btn-primary" onClick={() => void submit()}>
          Try saving again
        </button>
      </>
    );

  if (screen === "done" && result)
    return (
      <Finished
        result={result}
        name={form.name}
        prizeNote={props.prizeNote}
        slug={props.slug}
        onBoard={() => setScreen("board")}
      />
    );

  if (screen === "board")
    return <Leaderboard slug={props.slug} attemptId={attemptId} />;

  return <Loading label="Loading…" />;
}

/* ============================== sub-screens ============================== */

function Closed({ title, body, slug }: { title: string; body: string; slug: string }) {
  return (
    <>
      <h1 className="mb-3 font-display text-[28px] font-bold leading-tight text-plum">{title}</h1>
      <p className="mb-5 text-[15.5px] leading-relaxed text-[#463359]">{body}</p>
      <Link href={`/s/${slug}/dashboard`} className="btn-ghost">
        Open my dashboard
      </Link>
    </>
  );
}

function RegisterForm({
  form,
  setForm,
  error,
  busy,
  onSubmit,
  questionCount,
  played,
  timeLimitSeconds,
  requireEmail,
  collectClass,
  prizeNote,
  slug,
}: QuizFlowProps & {
  form: { name: string; phone: string; email: string; classOrYear: string };
  setForm: (f: { name: string; phone: string; email: string; classOrYear: string }) => void;
  error: string;
  busy: boolean;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <form onSubmit={onSubmit} noValidate>
      <h1 className="mb-3 font-display text-[30px] font-bold leading-[1.1] tracking-[-0.02em] text-plum">
        Quiz Challenge
      </h1>
      <p className="mb-5 font-display text-[19px] font-light leading-snug text-plum-soft">
        {questionCount} question{questionCount === 1 ? "" : "s"} on how life begins. Answer them
        right, answer them fast.
      </p>

      <PrizeNote text={prizeNote} />

      <label className="field" htmlFor="n">
        Full name
      </label>
      <input
        id="n"
        className="input"
        value={form.name}
        onChange={set("name")}
        autoComplete="name"
        disabled={busy}
      />

      <label className="field" htmlFor="p">
        Mobile number
      </label>
      <input
        id="p"
        className="input"
        type="tel"
        inputMode="numeric"
        maxLength={10}
        value={form.phone}
        onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
        autoComplete="tel"
        placeholder="10-digit number"
        disabled={busy}
      />

      <label className="field" htmlFor="e">
        Email address {requireEmail ? "" : <span className="normal-case">(optional)</span>}
      </label>
      <input
        id="e"
        className="input"
        type="email"
        inputMode="email"
        value={form.email}
        onChange={set("email")}
        autoComplete="email"
        placeholder="you@example.com"
        disabled={busy}
      />

      {collectClass ? (
        <>
          <label className="field" htmlFor="c">
            Class / year / branch
          </label>
          <input
            id="c"
            className="input"
            value={form.classOrYear}
            onChange={set("classOrYear")}
            placeholder="e.g. 2nd year BSc"
            disabled={busy}
          />
        </>
      ) : null}

      <p className="err mt-2.5" role="alert">
        {error}
      </p>

      {/* Not "Start the quiz" — this only registers you and opens the rules.
          The quiz itself starts on the button after them, and two buttons
          promising the same thing is how a student taps without reading. */}
      <button type="submit" className="btn-primary mt-4" disabled={busy}>
        {busy ? "Registering…" : "Continue"}
      </button>

      <p className="hint mt-3">
        {questionCount} questions ·{" "}
        {/* A timed quiz states its real limit. Only an untimed one is estimated,
            and it says "about" so it never reads as a promise. */}
        {timeLimitSeconds
          ? `${Math.round(timeLimitSeconds / 60)} minute${Math.round(timeLimitSeconds / 60) === 1 ? "" : "s"} to finish`
          : `about ${Math.max(2, Math.round(questionCount / 3))} minutes`}
        {played > 0 ? ` · ${played} already played` : ""}
      </p>
      <p className="mt-3 text-center">
        <Link href={`/s/${slug}/dashboard`} className="linkish">
          Already played? See your score
        </Link>
      </p>
    </form>
  );
}

/**
 * The rules, shown once between registering and the first question.
 *
 * Every line is built from the attempt this student was actually served, not
 * from a fixed script: the counts are real, the "select all that apply" rule
 * only appears when their paper contains one, and the marks line only claims
 * questions are worth different amounts when they are. A rule that does not
 * apply is worse than no rule, because it makes a student look for something
 * that is not there.
 *
 * It gives away nothing the phone was not already told — `multi` and `pts`
 * arrive with the questions themselves. The answer key never comes near it.
 */
function Instructions({
  questions,
  name,
  timeLimitSeconds,
  showLeaderboard,
  prizeNote,
  onBegin,
}: {
  questions: ClientQuestion[];
  name: string;
  timeLimitSeconds: number | null;
  showLeaderboard: boolean;
  prizeNote: string;
  onBegin: () => void;
}) {
  const total = questions.length;
  const marks = questions.reduce((sum, q) => sum + q.pts, 0);
  const multiCount = questions.filter((q) => q.multi).length;
  const mixedMarks = new Set(questions.map((q) => q.pts)).size > 1;
  const first = name.trim().split(" ")[0];
  const limitMinutes = timeLimitSeconds ? Math.round(timeLimitSeconds / 60) : 0;

  return (
    <>
      <h1 className="mb-1.5 font-display text-[28px] font-bold leading-tight text-plum">
        {first ? `Ready, ${first}?` : "Before you start"}
      </h1>
      <p className="mb-4 font-display text-[19px] font-light leading-snug text-plum-soft">
        Read this once — it takes ten seconds and it is worth marks.
      </p>

      {/* The two numbers that decide how hard to push. */}
      <div className={`mb-4 grid gap-2.5 ${limitMinutes ? "grid-cols-3" : "grid-cols-2"}`}>
        <Tile value={total} label={total === 1 ? "question" : "questions"} />
        <Tile value={marks} label={marks === 1 ? "mark in total" : "marks in total"} />
        {limitMinutes ? (
          <Tile value={limitMinutes} label={limitMinutes === 1 ? "minute" : "minutes"} />
        ) : null}
      </div>

      <ul className="mb-4 space-y-2.5">
        <Rule icon="☝️">
          <b>One tap locks your answer.</b> You cannot go back and you cannot change it, so read
          every option before you choose.
        </Rule>

        {multiCount > 0 ? (
          <Rule icon="✅">
            <b>
              {multiCount === 1
                ? "One question has more than one correct answer."
                : `${multiCount} questions have more than one correct answer.`}
            </b>{" "}
            Those are marked <i>Select all that apply</i>. Tap every option you think is right, then
            press Confirm. Only the exact set scores — half right earns nothing, and so does ticking
            everything.
          </Rule>
        ) : null}

        <Rule icon="🎯">
          {mixedMarks ? (
            <>
              <b>Questions are worth different marks.</b> Each one shows what it is worth in the top
              corner, so spend your time where it counts.
            </>
          ) : (
            <>
              <b>Every question is worth {questions[0]?.pts ?? 1} mark
              {(questions[0]?.pts ?? 1) === 1 ? "" : "s"}.</b> Each one shows this in the top corner.
            </>
          )}
        </Rule>

        {limitMinutes ? (
          <Rule icon="⏳">
            <b>
              You have {limitMinutes} minute{limitMinutes === 1 ? "" : "s"} for the whole quiz.
            </b>{" "}
            The countdown starts when you tap Start and runs in the top corner. When it reaches
            zero your answers are submitted automatically, so anything still unanswered stays
            unanswered — keep moving.
          </Rule>
        ) : null}

        <Rule icon="⏱️">
          <b>Your time is measured per question</b> — from the moment it appears to the moment you
          answer. {showLeaderboard ? "Ties on marks are broken by who answered faster." : "Take the time you need to read, but do not idle."}
        </Rule>

        <Rule icon="📶">
          <b>Stay on this page.</b> Your answers are only saved when you finish, so do not close the
          tab or hit back.
        </Rule>
      </ul>

      <PrizeNote text={prizeNote} />

      <button className="btn-primary" onClick={onBegin}>
        Start the quiz
      </button>
      <p className="hint mt-2.5">
        {limitMinutes
          ? `Your ${limitMinutes} minute${limitMinutes === 1 ? "" : "s"} start the moment you tap this.`
          : "The clock starts on the first question."}
      </p>
    </>
  );
}

/** One of the two counts at the top of the rules. */
const Tile = ({ value, label }: { value: number; label: string }) => (
  <div className="rounded-2xl bg-petal px-4 py-3 text-center">
    <div className="font-display text-[26px] font-bold leading-none tabular-nums text-plum">
      {value}
    </div>
    <div className="mt-1 text-[12.5px] leading-snug text-plum-soft">{label}</div>
  </div>
);

/** One rule. The icon is decorative — the sentence has to stand on its own. */
const Rule = ({ icon, children }: { icon: string; children: React.ReactNode }) => (
  <li className="flex items-start gap-2.5">
    <span className="mt-px shrink-0 text-[16px] leading-snug" aria-hidden="true">
      {icon}
    </span>
    <span className="text-[14.5px] leading-relaxed text-[#463359]">{children}</span>
  </li>
);

/**
 * One question. Timing starts when it renders and stops on the answer, so the
 * clock measures thinking time rather than how long the intro slide took.
 *
 * An ordinary question locks on the first tap — fastest for a room of students
 * on phones. A "select all that apply" question cannot work that way, so its
 * options toggle and a Confirm button commits the set. The phone is told only
 * that there is more than one right answer, never how many, so the count is no
 * help in guessing.
 */
function Question({
  question,
  index,
  total,
  remainingMs,
  onAnswer,
}: {
  question: ClientQuestion;
  index: number;
  total: number;
  /** Time left in the whole quiz, or null when the quiz is untimed. */
  remainingMs: number | null;
  onAnswer: (optionIndexes: number[], ms: number) => void;
}) {
  const multi = question.multi === true;
  const started = useRef(Date.now());
  const [tick, setTick] = useState(0);
  const [chosen, setChosen] = useState<number[]>([]);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    started.current = Date.now();
    const t = setInterval(() => setTick(Date.now() - started.current), 100);
    return () => clearInterval(t);
  }, []);

  function commit(picked: number[]) {
    if (locked) return;
    const ms = Date.now() - started.current;
    setLocked(true);
    setChosen(picked);
    // A beat of feedback so the tap registers visually before the screen changes.
    setTimeout(() => onAnswer(picked, ms), 260);
  }

  function tap(i: number) {
    if (locked) return;
    if (!multi) return commit([i]);
    setChosen((cur) =>
      cur.includes(i) ? cur.filter((k) => k !== i) : [...cur, i].sort((a, b) => a - b),
    );
  }

  const isChosen = (i: number) => chosen.includes(i);
  const dimmed = (i: number) => locked && !multi && !isChosen(i);

  return (
    <>
      <Dots total={total} done={index} />

      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="font-display text-[12.5px] font-bold uppercase tracking-[0.14em] text-apricot">
          Question {index + 1} of {total}
        </span>
        <span className="flex items-center gap-2">
          {/* What this one is worth, so a student can see where the marks are. */}
          <span className="rounded-full bg-petal px-2.5 py-[3px] font-display text-[11.5px] font-bold uppercase tracking-[0.08em] text-plum">
            {question.pts} mark{question.pts === 1 ? "" : "s"}
          </span>
          {/* On a timed quiz the clock that matters is the one running out, so
              it replaces the per-question stopwatch. The per-question time is
              still recorded either way — it is what breaks ties. */}
          {remainingMs === null ? (
            <span className="font-display text-[13px] font-medium tabular-nums text-plum-soft">
              {fmtSeconds(tick)}
            </span>
          ) : (
            <span
              className={[
                "font-display text-[14px] font-bold tabular-nums",
                remainingMs <= 60_000 ? "animate-pulseDot text-coral" : "text-plum-soft",
              ].join(" ")}
              role="timer"
              aria-live={remainingMs <= 60_000 ? "polite" : "off"}
            >
              {fmtClock(remainingMs)}
            </span>
          )}
        </span>
      </div>

      {question.img ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={question.img}
          // Never an empty alt: a picture the question depends on is not
          // decorative, so a screen reader has to at least announce it is there.
          alt={question.alt || "Picture for this question"}
          className="mb-4 max-h-[46vh] w-full rounded-2xl border-[1.5px] border-ink/10 bg-white object-contain"
        />
      ) : null}

      <QuestionText
        text={question.text}
        className="mb-2 font-display text-[19.5px] font-medium leading-[1.35] text-ink"
      />

      {multi ? (
        <p className="mb-4 inline-block rounded-full bg-apricot/20 px-3 py-1 font-display text-[12.5px] font-bold uppercase tracking-[0.1em] text-apricot-deep">
          Select all that apply
        </p>
      ) : null}

      <div className={multi ? "mt-1" : ""}>
        {question.opts.map((text, i) => (
          <button
            key={i}
            type="button"
            onClick={() => tap(i)}
            disabled={locked}
            aria-pressed={isChosen(i)}
            className={[
              "mb-2.5 flex w-full items-start gap-3 rounded-2xl border-[1.5px] px-4 py-3.5 text-left transition",
              isChosen(i)
                ? "border-apricot bg-apricot/20"
                : "border-ink/10 bg-white hover:border-plum/35 hover:bg-petal/60",
              dimmed(i) ? "opacity-45" : "",
            ].join(" ")}
          >
            <span
              className={[
                "mt-px grid h-6 w-6 shrink-0 place-items-center font-display text-[12px] font-bold",
                multi ? "rounded-md" : "rounded-lg",
                isChosen(i) ? "bg-apricot text-plum-deep" : "bg-petal text-plum-soft",
              ].join(" ")}
              aria-hidden="true"
            >
              {multi && isChosen(i) ? "✓" : "ABCDEFGH"[i]}
            </span>
            <span className="text-[15.5px] font-semibold leading-snug text-ink">{text}</span>
          </button>
        ))}
      </div>

      {multi ? (
        <>
          <button
            type="button"
            className="btn-primary mt-1.5"
            onClick={() => commit(chosen)}
            disabled={locked || chosen.length === 0}
          >
            {locked
              ? "Locking in…"
              : chosen.length === 0
                ? "Pick your answers"
                : `Confirm ${chosen.length} answer${chosen.length === 1 ? "" : "s"}`}
          </button>
          <p className="hint mt-2">
            Tap the options you think are right, then confirm. Only the exact set scores.
          </p>
        </>
      ) : index === 0 ? (
        /* Worth saying once, at the start — not on all fifteen screens. */
        <p className="hint mt-2">One tap locks your answer. You cannot go back.</p>
      ) : null}
    </>
  );
}

function Finished({
  result,
  name,
  prizeNote,
  slug,
  onBoard,
}: {
  result: SubmitResponse;
  name: string;
  prizeNote: string;
  slug: string;
  onBoard: () => void;
}) {
  const first = name.trim().split(" ")[0];
  return (
    <>
      <Dots total={result.questionCount} done={result.questionCount} />
      <h1 className="mb-3 font-display text-[28px] font-bold leading-tight text-plum">
        {first ? `Thanks, ${first}` : "Answers recorded"}
      </h1>

      {result.score !== null ? (
        <p className="mb-3 text-[16.5px] leading-relaxed text-[#463359]">
          You scored{" "}
          <b className="text-plum">
            {result.score} out of {result.maxScore}
          </b>
          {result.correctCount !== null && result.correctCount !== result.score ? (
            <> — {result.correctCount} of {result.questionCount} correct</>
          ) : null}
          .
        </p>
      ) : (
        <p className="mb-3 text-[16.5px] leading-relaxed text-[#463359]">
          All {result.questionCount} answers are in. Scores are announced after the session.
        </p>
      )}

      <PrizeNote text={prizeNote} />

      {result.showLeaderboard ? (
        <button className="btn-primary" onClick={onBoard}>
          View leaderboard
        </button>
      ) : null}
      <Link href={`/s/${slug}/dashboard`} className="btn-ghost mt-2.5">
        My dashboard
      </Link>
    </>
  );
}

function Leaderboard({ slug, attemptId }: { slug: string; attemptId: string }) {
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setBoard(
        await api<BoardResponse>(
          `/api/quiz/leaderboard?code=${encodeURIComponent(slug)}&attempt=${encodeURIComponent(attemptId)}`,
        ),
      );
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : errText(e));
    } finally {
      setBusy(false);
    }
  }, [slug, attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (busy && !board) return <Loading label="Loading leaderboard…" />;

  if (error && !board)
    return (
      <>
        <h2 className="mb-3 font-display text-[19px] font-medium text-plum">
          Leaderboard unavailable
        </h2>
        <p className="mb-4 text-[15.5px] leading-relaxed text-[#463359]">
          {error} Your entry is safely recorded.
        </p>
        <button className="btn-ghost" onClick={() => void load()}>
          Try again
        </button>
      </>
    );

  const you = board?.you ?? null;
  const outsideTop = you && you.rank > (board?.top.length ?? 10);

  return (
    <>
      <h1 className="mb-3 font-display text-[28px] font-bold leading-tight text-plum">
        Leaderboard
      </h1>
      <p className="mb-4 font-display text-[19px] font-light leading-snug text-plum-soft">
        {you ? (
          <>
            You are at rank <b className="font-medium text-plum">{you.rank}</b> of {board?.count}{" "}
            with <b className="font-medium text-plum">{you.score} points</b>.
          </>
        ) : (
          <>{board?.count ?? 0} students have played so far.</>
        )}
      </p>

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
            {board?.top.map((r) => (
              <BoardRow key={r.rank} row={r} isYou={you?.rank === r.rank} />
            ))}
            {outsideTop && you ? (
              <>
                <tr>
                  <td colSpan={3} className="text-center text-muted">
                    ···
                  </td>
                </tr>
                <BoardRow
                  row={{ rank: you.rank, name: you.name, score: you.score, maxScore: you.maxScore }}
                  isYou
                />
              </>
            ) : null}
            {!board?.top.length ? (
              <tr>
                <td colSpan={3} className="hint py-4 text-center">
                  No scores yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="hint mt-4">
        Ties are broken by answering speed, so the final order can differ from this board.
      </p>

      <button className="btn-ghost mt-4" onClick={() => void load()} disabled={busy}>
        {busy ? "Refreshing…" : "Refresh leaderboard"}
      </button>
      <Link href={`/s/${slug}/dashboard`} className="btn-ghost mt-2.5">
        My dashboard
      </Link>
    </>
  );
}

const MEDALS = ["🥇", "🥈", "🥉"];

function BoardRow({
  row,
  isYou,
}: {
  row: { rank: number; name: string; score: number; maxScore: number };
  isYou?: boolean;
}) {
  return (
    <tr className={isYou ? "bg-apricot/15" : ""}>
      <td className="font-display text-[15px] font-medium tabular-nums">
        {row.rank <= 3 ? MEDALS[row.rank - 1] : row.rank}
      </td>
      <td className="font-semibold">
        {row.name}
        {isYou ? <b className="ml-2 font-display text-[11px] uppercase text-apricot-deep">you</b> : null}
      </td>
      <td className="whitespace-nowrap text-right font-display font-medium tabular-nums">
        {row.score} pts
      </td>
    </tr>
  );
}
