import { randomInt } from "crypto";
import { sql } from "./db";
import type { Organization } from "./types";

/**
 * A snapshot of one question exactly as it was shown to one student.
 * Because the whole thing is stored on the attempt row, editing a question
 * mid-event never changes how an already-started quiz is marked.
 *
 * `ci` and `cis` say the same thing twice on purpose. `cis` is the real answer
 * key — an array, so a question can have several correct options. `ci` is its
 * first entry, kept so that an attempt snapshot written before multiple answers
 * existed still marks correctly, and so nothing that reads `ci` needs changing.
 */
export type ServedQuestion = {
  p: number; // position within this attempt, 0-based
  qid: number | null;
  text: string;
  opts: string[]; // in display order
  ci: number; // first correct index into `opts`
  cis?: number[]; // every correct index into `opts`, ascending
  pts: number;
  img?: string; // picture shown above the question, when there is one
  alt?: string; // its description, for screen readers
};

/**
 * The same question with the answer key removed — this is what the phone gets.
 * `multi` is the one thing the client is told about the key: that there is more
 * than one right option. It is not told how many, which would narrow the guess.
 */
export type ClientQuestion = Omit<ServedQuestion, "ci" | "cis"> & { multi: boolean };

/**
 * The answer key for one served question. Falls back to `ci` for snapshots
 * taken before `cis` existed, and for rows seeded by hand-written SQL.
 */
export function answerKey(q: ServedQuestion): number[] {
  const usable = (keys: unknown[]): number[] => {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const k of keys) {
      if (typeof k === "number" && Number.isInteger(k) && k >= 0 && k < q.opts.length && !seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
    return out.sort((a, b) => a - b);
  };

  // `cis` first, but only if something in it survives. A key that is missing,
  // empty, or entirely unusable falls back to `ci` — never to "no right answer
  // at all", which would silently mark a whole question wrong for everybody.
  const fromArray = Array.isArray(q.cis) ? usable(q.cis) : [];
  return fromArray.length ? fromArray : usable([q.ci]);
}

export const stripAnswers = (served: ServedQuestion[]): ClientQuestion[] =>
  served.map((q) => ({
    p: q.p,
    qid: q.qid,
    text: q.text,
    opts: q.opts,
    pts: q.pts,
    multi: answerKey(q).length > 1,
    ...(q.img ? { img: q.img, alt: q.alt ?? "" } : {}),
  }));

/** Fisher–Yates using a CSPRNG, so option order isn't predictable per student. */
function shuffled<T>(input: T[]): T[] {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type QuestionRow = {
  id: number;
  text: string;
  options: string[];
  correct_index: number;
  correct_indexes: number[];
  image_url: string;
  image_alt: string;
  points: number;
};

/**
 * Builds the question list for one attempt, honouring the organization's settings:
 * optional question shuffling, optional per-student option shuffling, and an
 * optional cap on how many of the set's questions get asked.
 */
export async function buildServedQuestions(organization: Organization): Promise<ServedQuestion[]> {
  if (!organization.question_set_id) return [];

  const rows = (await sql`
    SELECT id, text, options, correct_index, correct_indexes,
           image_url, image_alt, points
      FROM questions
     WHERE set_id = ${organization.question_set_id}
       AND is_deleted = false
       AND is_active = true
     ORDER BY position ASC, id ASC`) as unknown as QuestionRow[];

  let pool = rows;
  if (organization.shuffle_questions) pool = shuffled(pool);
  if (organization.question_count && organization.question_count < pool.length) {
    // When a subset is asked, take it at random rather than always the first N,
    // otherwise a cap of 10 on a 15-question set makes 5 questions dead weight.
    pool = (organization.shuffle_questions ? pool : shuffled(pool)).slice(0, organization.question_count);
  }

  return pool.map((q, i) => {
    const options = Array.isArray(q.options) ? q.options.map(String) : [];

    // The stored key, cleaned up: whole numbers, in range, no repeats. An empty
    // or unusable key falls back to correct_index, which every row has.
    const stored = Array.isArray(q.correct_indexes) ? q.correct_indexes.map(Number) : [];
    const keySet = new Set<number>();
    for (const k of stored) {
      if (Number.isInteger(k) && k >= 0 && k < options.length) keySet.add(k);
    }
    if (keySet.size === 0) {
      keySet.add(q.correct_index >= 0 && q.correct_index < options.length ? q.correct_index : 0);
    }

    // Shuffle a permutation of *indexes* rather than of the option strings, so
    // the key survives even if two options happen to read the same.
    const order = organization.shuffle_options
      ? shuffled(options.map((_, k) => k))
      : options.map((_, k) => k);

    const cis: number[] = [];
    order.forEach((original, shown) => {
      if (keySet.has(original)) cis.push(shown);
    });
    cis.sort((a, b) => a - b);

    return {
      p: i,
      qid: Number(q.id),
      text: q.text,
      opts: order.map((k) => options[k]),
      ci: cis[0] ?? 0,
      cis,
      pts: Number(q.points) || 1,
      ...(q.image_url ? { img: q.image_url, alt: q.image_alt ?? "" } : {}),
    };
  });
}

/**
 * What one phone sends back for one question. `optionIndexes` is the real
 * field — a set of taps. `optionIndex` is the single-answer form an older
 * client sends, and -1 there still means "left unanswered".
 */
export type SubmittedAnswer = {
  position: number;
  optionIndex?: number;
  optionIndexes?: number[];
  ms?: number;
};

/** The options a student actually chose: in range, de-duplicated, ascending. */
export function chosenIndexes(given: SubmittedAnswer | undefined, optionCount: number): number[] {
  const raw = Array.isArray(given?.optionIndexes)
    ? given.optionIndexes
    : typeof given?.optionIndex === "number"
      ? [given.optionIndex]
      : [];

  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of raw) {
    if (Number.isInteger(i) && i >= 0 && i < optionCount && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out.sort((a, b) => a - b);
}

/** How several chosen or correct options read on a report and in the export. */
export const JOIN = " | ";

export type Marked = {
  score: number;
  maxScore: number;
  correctCount: number;
  answerMs: number;
  rows: {
    position: number;
    questionId: number | null;
    questionText: string;
    chosenText: string;
    correctText: string;
    isCorrect: boolean;
    points: number;
    ms: number;
  }[];
};

/**
 * Marks a submission against the stored snapshot. Nothing the client sends is
 * trusted beyond "which options did I tap" — the score is computed here, so a
 * forged payload cannot award itself points.
 *
 * A question with several correct options is all-or-nothing: the chosen set has
 * to match the answer key exactly. Half of a two-answer question scores zero,
 * and so does picking every option to cover the possibilities.
 */
export function markSubmission(served: ServedQuestion[], answers: SubmittedAnswer[]): Marked {
  const byPosition = new Map<number, SubmittedAnswer>();
  for (const a of answers) {
    // Last write wins, and out-of-range positions are simply ignored.
    if (a.position >= 0 && a.position < served.length) byPosition.set(a.position, a);
  }

  let score = 0;
  let maxScore = 0;
  let correctCount = 0;
  let answerMs = 0;

  const rows = served.map((q) => {
    const given = byPosition.get(q.p);
    const key = answerKey(q);
    const chosen = chosenIndexes(given, q.opts.length);

    const isCorrect =
      chosen.length > 0 &&
      chosen.length === key.length &&
      chosen.every((i, k) => i === key[k]);

    const ms = Math.max(0, Math.min(60 * 60 * 1000, given?.ms ?? 0));

    maxScore += q.pts;
    answerMs += ms;
    if (isCorrect) {
      score += q.pts;
      correctCount += 1;
    }

    return {
      position: q.p,
      questionId: q.qid,
      questionText: q.text,
      chosenText: chosen.map((i) => q.opts[i]).join(JOIN),
      correctText: key.map((i) => q.opts[i]).join(JOIN),
      isCorrect,
      points: isCorrect ? q.pts : 0,
      ms,
    };
  });

  return { score, maxScore, correctCount, answerMs, rows };
}

/** mm:ss.s for the UI; the DB always keeps raw milliseconds. */
export function formatMs(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  const m = Math.floor(total / 60);
  const s = Math.round(total % 60);
  return s === 60 ? `${m + 1}m 00s` : `${m}m ${String(s).padStart(2, "0")}s`;
}
