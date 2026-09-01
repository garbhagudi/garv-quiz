"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiRetry, errText } from "@/lib/client";
import { Loading, PrizeNote, Progress } from "@/components/Stage";
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

/** How big the quiz is, without a word of what is in it. */
type QuizShape = {
  total: number;
  marks: number;
  multiCount: number;
  pointsEach: number;
  mixedMarks: boolean;
};

const shapeOf = (questions: ClientQuestion[]): QuizShape => ({
  total: questions.length,
  marks: questions.reduce((sum, q) => sum + q.pts, 0),
  multiCount: questions.filter((q) => q.multi).length,
  pointsEach: questions[0]?.pts ?? 1,
  mixedMarks: new Set(questions.map((q) => q.pts)).size > 1,
});

type StartResponse = {
  attemptId: string;
  questions: ClientQuestion[];
  /** Whole-quiz limit from the question set; null means untimed. */
  timeLimitSeconds: number | null;
  /**
   * What is actually left of this run. The same as the whole limit for a fresh
   * attempt, and less for one being picked up again - the server counts it from
   * when the attempt opened, so coming back on another phone continues the
   * clock rather than handing out a new one.
   */
  remainingMs: number | null;
  /** True when this is an attempt already under way, not a new one. */
  resumed?: boolean;
  student: { name: string };
};

/**
 * What comes back instead when the round has not started: registered, but with
 * nothing to answer yet. `beginsInMs` is null while the host has still not
 * pressed Start, and a countdown once they have.
 */
type WaitingResponse = {
  waiting: true;
  beginsInMs: number | null;
  timeLimitSeconds: number | null;
  summary: QuizShape;
  student: { name: string };
};

type SubmitResponse = {
  score: number | null;
  maxScore: number;
  correctCount: number | null;
  questionCount: number;
  /** Summed thinking time - the number that breaks ties when winners are picked. */
  answerMs: number;
  alreadySubmitted?: boolean;
};

type Screen =
  | "register"
  | "waiting"
  | "instructions"
  | "quiz"
  | "saving"
  | "saveFailed"
  | "done";

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
  prizeNote: string;
};

const fmtSeconds = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

/**
 * How long they took, for the finish screen. Seconds under a minute, m:ss above
 * it - the same number the host ranks ties by, so it reads the same on both
 * screens.
 */
const fmtTaken = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return t < 60 ? `${t}s` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

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
  /** What the server says is left, once it has told us. */
  const [resumeMs, setResumeMs] = useState<number | null>(null);
  const deadline = useRef(0);
  const [remainingMs, setRemainingMs] = useState(0);

  const [result, setResult] = useState<SubmitResponse | null>(null);

  /* ----------------------------- waiting room ---------------------------- */

  // What to draw on the rules while they wait, and when the questions arrive.
  // `beginsAt` is a wall-clock instant rather than a remaining count, so a
  // phone that sleeps through the lead-in catches up instead of starting late.
  const [shape, setShape] = useState<QuizShape | null>(null);
  const [beginsAt, setBeginsAt] = useState<number | null>(null);
  const [beginsInMs, setBeginsInMs] = useState<number | null>(null);
  const entering = useRef(false);

  /* ------------------------------ register ------------------------------- */

  /** Puts the countdown where the server says it is, and shows the questions. */
  const beginWith = useCallback((leftMs: number | null) => {
    runStart.current = Date.now();
    if (leftMs !== null) {
      deadline.current = Date.now() + leftMs;
      setRemainingMs(leftMs);
    }
    setScreen("quiz");
  }, []);


  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (form.name.trim().length < 3) return setError("Enter your full name.");
    if (!/^[6-9]\d{9}$/.test(form.phone)) return setError("Enter a valid 10-digit mobile number.");
    if (props.requireEmail && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(form.email))
      return setError("Enter a valid email address.");

    setBusy(true);
    try {
      const data = await api<StartResponse | WaitingResponse>("/api/quiz/start", {
        body: { slug: props.slug, ...form },
      });
      answers.current = [];
      setTimeLimitSeconds(data.timeLimitSeconds ?? null);
      setIndex(0);

      // Registered, but the round has not started. Nothing to answer yet, so
      // they read the rules here and the page watches for the host.
      if ("waiting" in data) {
        setShape(data.summary);
        setBeginsAt(data.beginsInMs === null ? null : Date.now() + data.beginsInMs);
        setBeginsInMs(data.beginsInMs);
        setScreen("waiting");
        setBusy(false);
        return;
      }

      setAttemptId(data.attemptId);
      setQuestions(data.questions);
      setShape(shapeOf(data.questions));
      setResumeMs(data.remainingMs ?? null);
      if (data.resumed) {
        // Their clock has been running since the attempt opened, so the rules
        // screen would be spending time they have already lost. Straight in.
        beginWith(data.remainingMs ?? null);
      } else {
        setScreen("instructions");
      }
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  /**
   * The second half of registering: the round is on, so open the attempt and
   * take the questions. Called when the lead-in runs out, never before — the
   * server stamps `started_at` here, and that is what the clock is read from at
   * both ends, so it has to be the moment the questions actually appear.
   */
  const enter = useCallback(async () => {
    if (entering.current) return;
    entering.current = true;
    try {
      const data = await apiRetry<StartResponse | WaitingResponse>("/api/quiz/start", {
        body: { slug: props.slug, ...form },
      });
      if ("waiting" in data) {
        // The host closed it again between the countdown and this call.
        setBeginsAt(data.beginsInMs === null ? null : Date.now() + data.beginsInMs);
        setBeginsInMs(data.beginsInMs);
        entering.current = false;
        return;
      }
      answers.current = [];
      setAttemptId(data.attemptId);
      setQuestions(data.questions);
      setIndex(0);
      setTimeLimitSeconds(data.timeLimitSeconds ?? null);
      beginWith(data.remainingMs ?? null);
    } catch (err) {
      setError(errText(err));
      entering.current = false;
    }
  }, [form, props.slug, beginWith]);

  /**
   * While they wait, ask the public route how the event is doing. It is the
   * same cheap query the landing page already runs, and it answers the only two
   * questions this screen has: has the host started, and how long until the
   * questions appear.
   *
   * `beginsInMs` is a duration measured on the server, so every phone counts
   * down to the same instant however late it happened to ask — one that only
   * hears about the round three seconds in shows a shorter countdown rather
   * than starting three seconds behind the room.
   */
  useEffect(() => {
    if (screen !== "waiting") return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (!document.hidden) {
        try {
          const r = await api<{
            organization: { isOpen: boolean; notStarted: boolean; beginsInMs: number | null };
          }>(`/api/public/organization?code=${encodeURIComponent(props.slug)}`, { method: "GET" });
          if (stop) return;
          const o = r.organization;
          if (!o.notStarted && o.beginsInMs !== null) {
            setBeginsAt(Date.now() + o.beginsInMs);
            setBeginsInMs(o.beginsInMs);
          } else if (!o.notStarted && o.isOpen && o.beginsInMs === null) {
            // Untimed, and now open — nothing to count down to.
            void enter();
            return;
          }
        } catch {
          /* hall wifi; the next tick will do */
        }
      }
      timer = setTimeout(poll, 2_000);
    };
    void poll();

    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [screen, props.slug, enter]);

  /** The lead-in itself: tick down to the shared instant, then take the questions. */
  useEffect(() => {
    if (screen !== "waiting" || beginsAt === null) return;
    const tick = setInterval(() => {
      const left = beginsAt - Date.now();
      setBeginsInMs(Math.max(0, left));
      if (left <= 0) {
        clearInterval(tick);
        void enter();
      }
    }, 100);
    return () => clearInterval(tick);
  }, [screen, beginsAt, enter]);

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
    beginWith(resumeMs ?? (timeLimitSeconds ? timeLimitSeconds * 1000 : null));
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
      />
    );

  if (!props.isOpen && screen === "register")
    return (
      <Closed
        title="This quiz has closed"
        body="If you already played, your answers are safely recorded."
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

  if (screen === "waiting")
    return (
      <Waiting
        name={form.name}
        shape={shape}
        timeLimitSeconds={timeLimitSeconds}
        beginsInMs={beginsInMs}
        prizeNote={props.prizeNote}
      />
    );

  if (screen === "instructions")
    return (
      <Instructions
        questions={questions}
        name={form.name}
        timeLimitSeconds={timeLimitSeconds}
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
      />
    );

  return <Loading label="Loading…" />;
}

/* ============================== sub-screens ============================== */

function Closed({ title, body }: { title: string; body: string }) {
  return (
    <>
      <h1 className="mb-3 font-display text-[28px] font-bold leading-tight text-plum">{title}</h1>
      <p className="mb-5 text-[15.5px] leading-relaxed text-[#463359]">{body}</p>
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

      {/* The placeholder says both names on purpose: a single name is refused
          with "Enter your full name.", and the first name is what recognises a
          student coming back having mistyped their number. */}
      <label className="field" htmlFor="n">
        Full name
      </label>
      <input
        id="n"
        className="input"
        value={form.name}
        onChange={set("name")}
        autoComplete="name"
        placeholder="First and last name"
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
/**
 * The waiting room.
 *
 * They are registered and the host has not started yet, so this screen has one
 * job beyond saying so: spend the wait on the rules, which is time the round no
 * longer has to pay for. Nothing here came from the question bank — only how
 * many questions there are and what they are worth.
 */
function Waiting({
  name,
  shape,
  timeLimitSeconds,
  beginsInMs,
  prizeNote,
}: {
  name: string;
  shape: QuizShape | null;
  timeLimitSeconds: number | null;
  /** Null until the host presses Start; then the lead-in, counting down. */
  beginsInMs: number | null;
  prizeNote: string;
}) {
  const first = name.trim().split(" ")[0];
  const starting = beginsInMs !== null;
  const seconds = Math.max(0, Math.ceil((beginsInMs ?? 0) / 1000));

  return (
    <>
      {starting ? (
        <div className="mb-4 text-center" role="status" aria-live="assertive">
          <p className="font-display text-[13px] font-medium uppercase tracking-[0.16em] text-plum-soft">
            Get ready
          </p>
          <div className="mt-1 font-display text-[72px] font-bold leading-none tabular-nums text-plum">
            {seconds}
          </div>
          <p className="mt-1 text-[14px] text-plum-soft">
            The first question is about to appear. Do not close this page.
          </p>
        </div>
      ) : (
        <>
          <h1 className="mb-1.5 font-display text-[28px] font-bold leading-tight text-plum">
            {first ? `You are in, ${first}` : "You are in"}
          </h1>
          <p className="mb-4 font-display text-[19px] font-light leading-snug text-plum-soft">
            Waiting for the host to start the quiz. Keep this page open — it begins on its own.
          </p>
          <div
            className="mb-4 flex items-center justify-center gap-2.5 rounded-2xl bg-petal px-4 py-3"
            role="status"
            aria-live="polite"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-plum"
              aria-hidden="true"
            />
            <span className="text-[14px] text-plum-soft">Waiting for the host…</span>
          </div>
        </>
      )}

      {shape ? (
        <>
          <p className="mb-3 text-center text-[13px] text-muted">
            {starting ? "One last look:" : "While you wait, read this — it is worth marks."}
          </p>
          <Counts shape={shape} timeLimitSeconds={timeLimitSeconds} />
          <Rules shape={shape} timeLimitSeconds={timeLimitSeconds} />
        </>
      ) : null}

      <PrizeNote text={prizeNote} />
    </>
  );
}

function Instructions({
  questions,
  name,
  timeLimitSeconds,
  prizeNote,
  onBegin,
}: {
  questions: ClientQuestion[];
  name: string;
  timeLimitSeconds: number | null;
  prizeNote: string;
  onBegin: () => void;
}) {
  const shape = shapeOf(questions);
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

      <Counts shape={shape} timeLimitSeconds={timeLimitSeconds} />
      <Rules shape={shape} timeLimitSeconds={timeLimitSeconds} />

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

/** The two or three numbers that decide how hard to push. */
function Counts({
  shape,
  timeLimitSeconds,
}: {
  shape: QuizShape;
  timeLimitSeconds: number | null;
}) {
  const { total, marks } = shape;
  const limitMinutes = timeLimitSeconds ? Math.round(timeLimitSeconds / 60) : 0;
  return (
    <>
      {/* The two numbers that decide how hard to push. */}
      <div className={`mb-4 grid gap-2.5 ${limitMinutes ? "grid-cols-3" : "grid-cols-2"}`}>
        <Tile value={total} label={total === 1 ? "question" : "questions"} />
        <Tile value={marks} label={marks === 1 ? "mark in total" : "marks in total"} />
        {limitMinutes ? (
          <Tile value={limitMinutes} label={limitMinutes === 1 ? "minute" : "minutes"} />
        ) : null}
      </div>

    </>
  );
}

/** The rules themselves, shared by the waiting room and the pre-start screen. */
function Rules({
  shape,
  timeLimitSeconds,
}: {
  shape: QuizShape;
  timeLimitSeconds: number | null;
}) {
  const { multiCount, mixedMarks, pointsEach } = shape;
  const limitMinutes = timeLimitSeconds ? Math.round(timeLimitSeconds / 60) : 0;

  return (
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
              <b>Every question is worth {pointsEach} mark
              {pointsEach === 1 ? "" : "s"}.</b> Each one shows this in the top corner.
            </>
          )}
        </Rule>

        {limitMinutes ? (
          <Rule icon="⏳">
            <b>
              You have {limitMinutes} minute{limitMinutes === 1 ? "" : "s"} for the whole quiz.
            </b>{" "}
            The countdown runs in the top corner from the first question. When it reaches zero
            your answers are submitted automatically, so anything still unanswered stays
            unanswered — keep moving.
          </Rule>
        ) : null}

        <Rule icon="⏱️">
          <b>Your time is measured per question</b> — from the moment it appears to the moment you
          answer. Ties on marks are broken by who answered faster, so do not idle.
        </Rule>

        <Rule icon="📶">
          <b>Stay on this page.</b> Your answers are only saved when you finish, so do not close the
          tab or hit back.
        </Rule>
      </ul>
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
    /* Back to the top for each question. The component remounts on `key`, but
       the window keeps its scroll position - so a student who scrolled down to
       reach option D landed on the next question already past its wording. No
       smooth scroll: this is a new screen, not a journey, and at ten seconds a
       question the animation is time taken from reading. */
    window.scrollTo(0, 0);
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
      <div className="mb-2 flex items-center justify-between gap-2">
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
            /* Under a minute the urgency used to come from scaling the digits
               28% on a loop, which is the one moment they most need to be read.
               The number now holds still in coral and a small dot does the
               pulsing beside it - which is what that animation was built for. */
            <span
              className={[
                "flex items-center gap-1.5 font-display text-[14px] font-bold tabular-nums",
                remainingMs <= 60_000 ? "text-coral" : "text-plum-soft",
              ].join(" ")}
              role="timer"
              aria-live={remainingMs <= 60_000 ? "polite" : "off"}
            >
              {remainingMs <= 60_000 ? (
                <span
                  className="h-[7px] w-[7px] shrink-0 animate-pulseDot rounded-full bg-coral"
                  aria-hidden="true"
                />
              ) : null}
              {fmtClock(remainingMs)}
            </span>
          )}
        </span>
      </div>

      <Progress done={index} total={total} />

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
}: {
  result: SubmitResponse;
  name: string;
  prizeNote: string;
}) {
  const first = name.trim().split(" ")[0];
  return (
    <>
      <Progress done={result.questionCount} total={result.questionCount} />
      <h1 className="mb-3 font-display text-[28px] font-bold leading-tight text-plum">
        {first ? `Thank you, ${first}` : "Thank you for taking part"}
      </h1>

      {result.score !== null ? (
        <>
          <p className="mb-3 text-[16.5px] leading-relaxed text-[#463359]">
            Your answers are in. Here is how you did.
          </p>
          <div className="mb-4 grid grid-cols-2 gap-2.5">
            <ScoreTile
              value={`${result.score}/${result.maxScore}`}
              label={
                result.correctCount !== null
                  ? `${result.correctCount} of ${result.questionCount} correct`
                  : "your score"
              }
            />
            <ScoreTile value={fmtTaken(result.answerMs)} label="your time" />
          </div>
          <p className="mb-4 text-[15.5px] leading-relaxed text-[#463359]">
            Winners will be announced by the host shortly. Ties on marks go to the faster time, so
            hold on to yours.
          </p>
        </>
      ) : (
        <p className="mb-4 text-[16.5px] leading-relaxed text-[#463359]">
          All {result.questionCount} answers are in. Winners will be announced by the host shortly.
        </p>
      )}

      <PrizeNote text={prizeNote} />

      <p className="hint mt-2.5">
        Nothing more to do here — you can put your phone away.
      </p>
    </>
  );
}

/** One of the two numbers on the finish screen. */
const ScoreTile = ({ value, label }: { value: string; label: string }) => (
  <div className="rounded-2xl bg-petal px-4 py-3 text-center">
    <div className="font-display text-[26px] font-bold leading-none tabular-nums text-plum">
      {value}
    </div>
    <div className="mt-1 text-[12.5px] leading-snug text-plum-soft">{label}</div>
  </div>
);
