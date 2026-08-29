/**
 * Checks the pure logic that decides scores and identities — the parts where a
 * mistake would quietly award the wrong winner.
 *
 *   node --experimental-strip-types scripts/verify-logic.ts
 */
import {
  markSubmission,
  formatMs,
  answerKey,
  chosenIndexes,
  stripAnswers,
  type ServedQuestion,
} from "../src/lib/quiz.ts";
import {
  parseQuestionText,
  normalizeQuestionText,
  isPlainQuestionText,
  flattenQuestionText,
} from "../src/lib/questionText.ts";
import { nameMatches } from "../src/lib/identity.ts";
import {
  slugify,
  normalizePhone,
  phoneField,
  emailField,
  nameField,
  answerKeyOf,
  imageUrlField,
  questionSchema,
} from "../src/lib/validate.ts";

let pass = 0;
const failures: string[] = [];

function check(label: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${label}`);
  } catch (e) {
    failures.push(`${label}: ${(e as Error).message}`);
    console.log(`  FAIL  ${label}\n        ${(e as Error).message}`);
  }
}

function eq(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, expected ${b}`);
}

/** Three questions: the correct option sits at a different index in each. */
const served: ServedQuestion[] = [
  { p: 0, qid: 1, text: "Q1", opts: ["w", "right", "w2"], ci: 1, pts: 1 },
  { p: 1, qid: 2, text: "Q2", opts: ["right", "w"], ci: 0, pts: 1 },
  { p: 2, qid: 3, text: "Q3", opts: ["a", "b", "c", "right"], ci: 3, pts: 2 },
];

console.log("\nVerifying scoring and validation logic\n");

check("all correct scores full marks, including the 2-point question", () => {
  const m = markSubmission(served, [
    { position: 0, optionIndex: 1, ms: 1000 },
    { position: 1, optionIndex: 0, ms: 2000 },
    { position: 2, optionIndex: 3, ms: 3000 },
  ]);
  eq(m.score, 4, "score");
  eq(m.maxScore, 4, "maxScore");
  eq(m.correctCount, 3, "correctCount");
  eq(m.answerMs, 6000, "answerMs");
});

check("all wrong scores zero but still reports maxScore", () => {
  const m = markSubmission(served, [
    { position: 0, optionIndex: 0, ms: 10 },
    { position: 1, optionIndex: 1, ms: 10 },
    { position: 2, optionIndex: 0, ms: 10 },
  ]);
  eq(m.score, 0, "score");
  eq(m.maxScore, 4, "maxScore");
  eq(m.correctCount, 0, "correctCount");
});

check("a skipped question counts as wrong, not as a crash", () => {
  const m = markSubmission(served, [{ position: 0, optionIndex: 1, ms: 500 }]);
  eq(m.score, 1, "score");
  eq(m.rows.length, 3, "row count");
  eq(m.rows[1].chosenText, "", "skipped chosenText");
  eq(m.rows[1].isCorrect, false, "skipped isCorrect");
});

check("optionIndex -1 (no answer) is wrong and blank", () => {
  const m = markSubmission(served, [{ position: 0, optionIndex: -1, ms: 100 }]);
  eq(m.score, 0, "score");
  eq(m.rows[0].chosenText, "", "chosenText");
});

check("an out-of-range optionIndex cannot score", () => {
  const m = markSubmission(served, [
    { position: 0, optionIndex: 99, ms: 1 },
    { position: 1, optionIndex: 50, ms: 1 },
  ]);
  eq(m.score, 0, "score");
  eq(m.rows[0].chosenText, "", "chosenText");
});

check("answers for positions that were never served are ignored", () => {
  const m = markSubmission(served, [
    { position: 0, optionIndex: 1, ms: 100 },
    { position: 7, optionIndex: 0, ms: 100 },
    { position: -3, optionIndex: 0, ms: 100 },
  ]);
  eq(m.score, 1, "score");
  eq(m.rows.length, 3, "row count");
  eq(m.answerMs, 100, "answerMs excludes the phantom answers");
});

check("a duplicate answer for one position keeps only the last", () => {
  const m = markSubmission(served, [
    { position: 0, optionIndex: 0, ms: 100 },
    { position: 0, optionIndex: 1, ms: 200 },
  ]);
  eq(m.score, 1, "score");
  eq(m.answerMs, 200, "answerMs counts one answer per question");
});

check("a padded answer list cannot inflate answerMs", () => {
  const flood = Array.from({ length: 50 }, () => ({ position: 0, optionIndex: 1, ms: 60_000 }));
  const m = markSubmission(served, flood);
  eq(m.score, 1, "score");
  eq(m.answerMs, 60_000, "answerMs");
});

check("a negative or absurd ms is clamped", () => {
  const m = markSubmission(served, [
    { position: 0, optionIndex: 1, ms: -5000 },
    { position: 1, optionIndex: 0, ms: 999_999_999 },
  ]);
  eq(m.rows[0].ms, 0, "negative ms clamped to 0");
  eq(m.rows[1].ms, 3_600_000, "huge ms clamped to one hour");
});

check("points are awarded per question, not one each", () => {
  const m = markSubmission(served, [{ position: 2, optionIndex: 3, ms: 10 }]);
  eq(m.score, 2, "score for the 2-point question");
  eq(m.correctCount, 1, "correctCount");
  eq(m.rows[2].points, 2, "row points");
});

check("correctText is recorded for review even when the answer is wrong", () => {
  const m = markSubmission(served, [{ position: 2, optionIndex: 0, ms: 10 }]);
  eq(m.rows[2].correctText, "right", "correctText");
  eq(m.rows[2].chosenText, "a", "chosenText");
});

check("an empty submission is a clean zero", () => {
  const m = markSubmission(served, []);
  eq(m.score, 0, "score");
  eq(m.maxScore, 4, "maxScore");
  eq(m.answerMs, 0, "answerMs");
  eq(m.rows.length, 3, "row count");
});

/* --------------------- several correct options per question --------------- */

/**
 * Q1 has two right options, Q2 has three, Q3 has one. The single-answer form is
 * deliberately mixed in: both kinds share one code path and one attempt.
 */
const multiServed: ServedQuestion[] = [
  { p: 0, qid: 1, text: "Pick two", opts: ["a", "b", "c", "d"], ci: 0, cis: [0, 2], pts: 2 },
  { p: 1, qid: 2, text: "Pick three", opts: ["w", "x", "y", "z"], ci: 1, cis: [1, 2, 3], pts: 3 },
  { p: 2, qid: 3, text: "Pick one", opts: ["p", "q"], ci: 1, cis: [1], pts: 1 },
];

check("the exact set of correct options scores full marks", () => {
  const m = markSubmission(multiServed, [
    { position: 0, optionIndexes: [0, 2], ms: 1000 },
    { position: 1, optionIndexes: [1, 2, 3], ms: 2000 },
    { position: 2, optionIndexes: [1], ms: 500 },
  ]);
  eq(m.score, 6, "score");
  eq(m.maxScore, 6, "maxScore");
  eq(m.correctCount, 3, "correctCount");
});

check("the order options were tapped in does not matter", () => {
  const m = markSubmission(multiServed, [{ position: 1, optionIndexes: [3, 1, 2], ms: 10 }]);
  eq(m.rows[1].isCorrect, true, "isCorrect");
  eq(m.score, 3, "score");
});

check("half of a multi-answer question scores nothing", () => {
  const m = markSubmission(multiServed, [
    { position: 0, optionIndexes: [0], ms: 10 },
    { position: 1, optionIndexes: [1, 2], ms: 10 },
  ]);
  eq(m.score, 0, "score");
  eq(m.correctCount, 0, "correctCount");
  eq(m.rows[0].chosenText, "a", "chosenText still records what was picked");
});

check("ticking every option cannot win a multi-answer question", () => {
  const m = markSubmission(multiServed, [
    { position: 0, optionIndexes: [0, 1, 2, 3], ms: 10 },
    { position: 1, optionIndexes: [0, 1, 2, 3], ms: 10 },
  ]);
  eq(m.score, 0, "score");
});

check("one extra tick alongside the right pair scores nothing", () => {
  const m = markSubmission(multiServed, [{ position: 0, optionIndexes: [0, 1, 2], ms: 10 }]);
  eq(m.rows[0].isCorrect, false, "isCorrect");
});

check("chosen and correct options are both recorded for review", () => {
  const m = markSubmission(multiServed, [{ position: 1, optionIndexes: [1, 3], ms: 10 }]);
  eq(m.rows[1].chosenText, "x | z", "chosenText");
  eq(m.rows[1].correctText, "x | y | z", "correctText");
});

check("a multi-answer question left blank is wrong, not a crash", () => {
  const m = markSubmission(multiServed, [{ position: 0, optionIndexes: [], ms: 10 }]);
  eq(m.rows[0].isCorrect, false, "isCorrect");
  eq(m.rows[0].chosenText, "", "chosenText");
  eq(m.rows.length, 3, "row count");
});

check("repeated and out-of-range ticks are cleaned before marking", () => {
  const m = markSubmission(multiServed, [
    // The right pair, but sent with a repeat and two impossible indexes.
    { position: 0, optionIndexes: [2, 0, 0, 99, -4], ms: 10 },
  ]);
  eq(m.rows[0].isCorrect, true, "the real answer still counts");
  eq(m.rows[0].chosenText, "a | c", "chosenText is de-duplicated and in option order");
});

check("padding a multi-answer tick list cannot inflate the score", () => {
  const m = markSubmission(multiServed, [
    { position: 0, optionIndexes: [0, 2], ms: 10 },
    { position: 0, optionIndexes: [0, 2], ms: 10 },
    { position: 0, optionIndexes: [0, 2], ms: 10 },
  ]);
  eq(m.score, 2, "score counts the question once");
  eq(m.answerMs, 10, "answerMs counts one answer per question");
});

check("a snapshot with no cis still marks off its single ci", () => {
  // Exactly what an attempt started before multiple answers existed looks like.
  const legacy: ServedQuestion[] = [
    { p: 0, qid: 1, text: "Q", opts: ["wrong", "right"], ci: 1, pts: 1 },
  ];
  eq(answerKey(legacy[0]), [1], "answerKey falls back to ci");
  eq(markSubmission(legacy, [{ position: 0, optionIndexes: [1], ms: 1 }]).score, 1, "score");
  eq(markSubmission(legacy, [{ position: 0, optionIndexes: [0, 1], ms: 1 }]).score, 0, "guessing both");
});

check("an empty cis also falls back rather than marking everything wrong", () => {
  const q: ServedQuestion = { p: 0, qid: 1, text: "Q", opts: ["a", "b"], ci: 1, cis: [], pts: 1 };
  eq(answerKey(q), [1], "answerKey");
  eq(markSubmission([q], [{ position: 0, optionIndexes: [1], ms: 1 }]).score, 1, "score");
});

check("a cis that points outside the options is discarded", () => {
  const q: ServedQuestion = { p: 0, qid: 1, text: "Q", opts: ["a", "b"], ci: 0, cis: [5], pts: 1 };
  eq(answerKey(q), [0], "answerKey falls back to ci");
});

check("an older client sending one optionIndex is still marked", () => {
  const m = markSubmission(multiServed, [
    { position: 2, optionIndex: 1, ms: 10 },
    { position: 0, optionIndex: 0, ms: 10 },
  ]);
  eq(m.rows[2].isCorrect, true, "the single-answer question");
  eq(m.rows[0].isCorrect, false, "one tap cannot answer a two-answer question");
  eq(m.score, 1, "score");
});

check("optionIndex -1 from an older client is still no answer", () => {
  const m = markSubmission(multiServed, [{ position: 2, optionIndex: -1, ms: 10 }]);
  eq(m.rows[2].chosenText, "", "chosenText");
  eq(m.rows[2].isCorrect, false, "isCorrect");
});

check("chosenIndexes keeps only usable, unrepeated indexes, ascending", () => {
  eq(chosenIndexes({ position: 0, optionIndexes: [3, 1, 1, 0] }, 4), [0, 1, 3]);
  // 4 is past the last option, -1 is not an option, 1.5 is not an index at all.
  eq(chosenIndexes({ position: 0, optionIndexes: [4, -1, 1.5] }, 4), []);
  eq(chosenIndexes({ position: 0, optionIndex: 2 }, 4), [2]);
  eq(chosenIndexes({ position: 0, optionIndex: -1 }, 4), []);
  eq(chosenIndexes(undefined, 4), []);
  // optionIndexes wins when both arrive, so a stale field cannot override a tap.
  eq(chosenIndexes({ position: 0, optionIndex: 0, optionIndexes: [1, 2] }, 4), [1, 2]);
});

/* ----------------------- what the phone is allowed to see ---------------- */

check("the answer key never reaches the phone, in either shape", () => {
  const sent = stripAnswers(multiServed);
  const json = JSON.stringify(sent);
  if (json.includes('"ci"') || json.includes('"cis"'))
    throw new Error("the answer key leaked: " + json);
  eq(
    sent.map((q) => q.multi),
    [true, true, false],
    "multi flag",
  );
  // The count is deliberately withheld — knowing "pick exactly 3" is a big hint.
  if (json.includes('"count"')) throw new Error("how many answers to pick leaked");
});

check("a question's picture is passed through to the phone", () => {
  const withImage: ServedQuestion[] = [
    {
      p: 0,
      qid: 1,
      text: "What stage is this?",
      opts: ["Morula", "Blastocyst"],
      ci: 1,
      cis: [1],
      pts: 1,
      img: "/api/media/2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      alt: "Embryo under a microscope",
    },
  ];
  const [sent] = stripAnswers(withImage);
  eq(sent.img, "/api/media/2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "img");
  eq(sent.alt, "Embryo under a microscope", "alt");
});

/* ------------------------- the answer key on the way in ------------------ */

check("answerKeyOf reads either field and normalises it", () => {
  eq(answerKeyOf({ correctIndexes: [2, 0, 2] }), [0, 2], "de-duplicated and sorted");
  eq(answerKeyOf({ correctIndex: 3 }), [3], "the single-answer field");
  eq(answerKeyOf({ correctIndex: 0 }), [0], "index zero is not mistaken for absent");
  eq(answerKeyOf({ correctIndexes: [1], correctIndex: 9 }), [1], "the array wins");
  eq(answerKeyOf({}), [], "nothing given");
  eq(answerKeyOf({ correctIndexes: [] }), [], "an empty array is nothing given");
});

check("questionSchema accepts a multi-answer question", () => {
  const r = questionSchema.safeParse({
    setId: 1,
    text: "Which two are gametes?",
    options: ["Sperm", "Oocyte", "Zygote", "Morula"],
    correctIndexes: [0, 1],
  });
  if (!r.success) throw new Error("rejected a valid question: " + r.error.issues[0].message);
  eq(answerKeyOf(r.data), [0, 1], "answer key");
  eq(r.data.imageUrl, "", "imageUrl defaults to blank");
});

check("questionSchema still accepts the old single-answer field", () => {
  const r = questionSchema.safeParse({
    setId: 1,
    text: "Which one implants?",
    options: ["Zygote", "Blastocyst"],
    correctIndex: 1,
  });
  if (!r.success) throw new Error("rejected a valid question: " + r.error.issues[0].message);
  eq(answerKeyOf(r.data), [1], "answer key");
});

check("questionSchema refuses answer keys that cannot be marked", () => {
  const base = { setId: 1, text: "Which two are gametes?", options: ["a", "b", "c"] };
  const bad: [string, unknown][] = [
    ["no key at all", { ...base }],
    ["an empty key", { ...base, correctIndexes: [] }],
    ["an index past the last option", { ...base, correctIndexes: [0, 3] }],
    ["every option correct", { ...base, correctIndexes: [0, 1, 2] }],
    ["two identical options", { ...base, options: ["a", "A", "b"], correctIndexes: [0] }],
    ["a blank option", { ...base, options: ["a", "", "b"], correctIndexes: [0] }],
    ["one option only", { ...base, options: ["a"], correctIndexes: [0] }],
  ];
  for (const [label, body] of bad) {
    if (questionSchema.safeParse(body).success) throw new Error("accepted " + label);
  }
});

check("imageUrlField takes an upload path or an https link, nothing else", () => {
  for (const good of [
    "",
    "/api/media/2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    "https://cdn.example.com/embryo.png",
  ]) {
    if (!imageUrlField.safeParse(good).success)
      throw new Error("rejected valid: " + JSON.stringify(good));
  }
  for (const bad of [
    "http://cdn.example.com/x.png",
    "javascript:alert(1)",
    "/api/media/not-a-uuid",
    "/etc/passwd",
    "data:image/png;base64,AAAA",
    "https://x.com/a b.png",
    "https://" + "x".repeat(600),
  ]) {
    if (imageUrlField.safeParse(bad).success) throw new Error("accepted invalid: " + bad);
  }
});

/* --------------------- bullet points in question wording ----------------- */

check("a one-line question is left exactly as it was", () => {
  const t = "Which developmental stage is reached around Day 5-6?";
  eq(parseQuestionText(t), [{ kind: "text", lines: [t] }]);
  eq(isPlainQuestionText(t), true, "isPlainQuestionText");
  eq(flattenQuestionText(t), t, "flattenQuestionText");
});

check("dash lines become one bullet list under the wording", () => {
  eq(
    parseQuestionText("Which are true?\n- It forms on Day 5\n- It has an inner cell mass"),
    [
      { kind: "text", lines: ["Which are true?"] },
      { kind: "bullets", items: ["It forms on Day 5", "It has an inner cell mass"] },
    ],
  );
});

check("a dash with no space after it is still a bullet, as people type them", () => {
  // Exactly the wording in the GARV set: no space after the dash.
  eq(
    parseQuestionText(
      "In a patient undergoing ovarian stimulation:\n-Estradiol is rising rapidly.\n-What is the interpretation?",
    ),
    [
      { kind: "text", lines: ["In a patient undergoing ovarian stimulation:"] },
      {
        kind: "bullets",
        items: ["Estradiol is rising rapidly.", "What is the interpretation?"],
      },
    ],
  );
});

check("every marker works with and without a space", () => {
  for (const marker of ["-", "*", "•", "·"]) {
    eq(
      parseQuestionText(`Q?\n${marker} spaced\n${marker}unspaced`)[1],
      { kind: "bullets", items: ["spaced", "unspaced"] },
      `marker ${marker}`,
    );
  }
  eq(parseQuestionText("Q?\n1.unspaced\n2) spaced")[1], {
    kind: "numbers",
    items: ["unspaced", "spaced"],
  });
});

check("a measurement or a rule of dashes is never mistaken for a bullet", () => {
  for (const line of [
    "-196°C is the temperature of liquid nitrogen",
    "-20 to -80 is the usual range",
    "----------",
    "--",
    "-",
    "1.5 mm from the fundus",
    "2.5 ng/mL was the reading",
  ]) {
    const blocks = parseQuestionText(`Q?\n${line}`);
    eq(blocks.length, 1, `"${line}" started a list`);
    eq(blocks[0].kind, "text", `"${line}" started a list`);
  }
});

check("a bullet may still begin with a number when a space separates it", () => {
  eq(parseQuestionText("Q?\n- 21 mm follicle\n- 8-10 mm cohort")[1], {
    kind: "bullets",
    items: ["21 mm follicle", "8-10 mm cohort"],
  });
});

check("asterisks and bullet characters are bullets too", () => {
  for (const marker of ["-", "*", "•", "·", "‣", "▪"]) {
    eq(
      parseQuestionText(`Q?\n${marker} first\n${marker} second`)[1],
      { kind: "bullets", items: ["first", "second"] },
      `marker ${marker}`,
    );
  }
});

check("1. and 2) lines become a numbered list", () => {
  eq(parseQuestionText("Order these:\n1. Zygote\n2) Morula\n3. Blastocyst")[1], {
    kind: "numbers",
    items: ["Zygote", "Morula", "Blastocyst"],
  });
});

check("bullets and numbers stay in separate lists", () => {
  const blocks = parseQuestionText("Q?\n- a\n- b\n1. one\n2. two");
  eq(blocks.length, 3, "block count");
  eq(blocks[1].kind, "bullets", "first list");
  eq(blocks[2].kind, "numbers", "second list");
});

check("wording after a list starts a new paragraph", () => {
  eq(parseQuestionText("Read these:\n- a\n- b\nNow pick one.").map((b) => b.kind), [
    "text",
    "bullets",
    "text",
  ]);
});

check("a marker with nothing after it is ordinary wording, not an empty bullet", () => {
  // Somebody typing a range, or a dash on its own, must not create a bullet.
  eq(parseQuestionText("Day 5-6 - what stage?"), [
    { kind: "text", lines: ["Day 5-6 - what stage?"] },
  ]);
  eq(parseQuestionText("Q?\n-"), [{ kind: "text", lines: ["Q?", "-"] }]);
  eq(parseQuestionText("Q?\n- "), [{ kind: "text", lines: ["Q?", "-"] }]);
});

check("a mid-sentence asterisk or dash is never a list", () => {
  const t = "Is 2 * 3 = 6, and is 10 - 4 = 6?";
  eq(isPlainQuestionText(t), true, `treated as a list: ${JSON.stringify(parseQuestionText(t))}`);
});

check("a year cannot accidentally start a numbered list", () => {
  // Three or more digits is not a list marker, so "2026. Which..." stays text.
  eq(parseQuestionText("2026. Which college?"), [
    { kind: "text", lines: ["2026. Which college?"] },
  ]);
});

check("normalizeQuestionText tidies what was pasted in", () => {
  eq(normalizeQuestionText("Q?\r\n- a\r\n- b"), "Q?\n- a\n- b", "windows line endings");
  eq(normalizeQuestionText("Q?   \n- a  "), "Q?\n- a", "trailing spaces");
  eq(normalizeQuestionText("Q?\n\n\n\n- a"), "Q?\n\n- a", "a wall of blank lines");
  eq(normalizeQuestionText("\n\n  Q?  \n\n"), "Q?", "leading and trailing blank lines");
  eq(normalizeQuestionText(null), "", "nothing at all");
});

check("blank lines separate paragraphs without becoming one", () => {
  eq(parseQuestionText("First line.\n\nSecond line."), [
    { kind: "text", lines: ["First line."] },
    { kind: "text", lines: ["Second line."] },
  ]);
});

check("flattenQuestionText gives one line for a log or a spreadsheet", () => {
  eq(
    flattenQuestionText("Which are true?\n- It forms on Day 5\n- It has an ICM"),
    "Which are true? • It forms on Day 5 • It has an ICM",
  );
  eq(flattenQuestionText("Order:\n1. Zygote\n2. Morula"), "Order: • Zygote • Morula");
});

check("the wording is never treated as HTML or Markdown", () => {
  // Whatever an admin types stays text: the renderer takes strings, so there is
  // nothing here that could become a tag.
  const t = "Is <b>this</b> & that > those?\n- <script>alert(1)</script>\n- **bold**";
  const blocks = parseQuestionText(t);
  eq(blocks[0], { kind: "text", lines: ["Is <b>this</b> & that > those?"] });
  eq(blocks[1], {
    kind: "bullets",
    items: ["<script>alert(1)</script>", "**bold**"],
  });
});

check("questionSchema accepts a question with a bullet list", () => {
  const r = questionSchema.safeParse({
    setId: 1,
    text: "Which of these are true of a blastocyst?\r\n- It forms around Day 5-6\r\n- It has an ICM  ",
    options: ["Both", "Neither", "Only the first"],
    correctIndexes: [0],
  });
  if (!r.success) throw new Error("rejected a valid question: " + r.error.issues[0].message);
  eq(
    r.data.text,
    "Which of these are true of a blastocyst?\n- It forms around Day 5-6\n- It has an ICM",
    "stored wording",
  );
});

check("questionSchema refuses wording that is too long or too many lines", () => {
  const base = { setId: 1, options: ["a", "b", "c"], correctIndexes: [0] };
  if (questionSchema.safeParse({ ...base, text: "x".repeat(2001) }).success)
    throw new Error("accepted 2001 characters");
  const manyLines = ["Q?", ...Array.from({ length: 40 }, (_, i) => `- item ${i}`)].join("\n");
  if (questionSchema.safeParse({ ...base, text: manyLines }).success)
    throw new Error("accepted 41 lines");
  // Right at the limits, both must still go through.
  if (!questionSchema.safeParse({ ...base, text: "x".repeat(2000) }).success)
    throw new Error("rejected exactly 2000 characters");
  const fortyLines = ["Q?", ...Array.from({ length: 39 }, (_, i) => `- item ${i}`)].join("\n");
  if (!questionSchema.safeParse({ ...base, text: fortyLines }).success)
    throw new Error("rejected exactly 40 lines");
});

check("a bullet list survives being served to a phone unchanged", () => {
  const wording = "Which are true?\n- It forms on Day 5\n- It has an ICM";
  const [sent] = stripAnswers([
    { p: 0, qid: 1, text: wording, opts: ["Both", "Neither"], ci: 0, cis: [0], pts: 1 },
  ]);
  eq(sent.text, wording, "the phone gets the wording verbatim, markers and all");
});

/* ------------------------ telling students apart ------------------------- */

check("nameMatches accepts the ways a student retypes their own name", () => {
  for (const [given, stored] of [
    ["Asha Rao", "Asha Rao"],
    ["  asha   rao  ", "Asha Rao"],
    ["ASHA RAO", "Asha Rao"],
    ["Asha", "Asha Rao"],
    ["asha", "Asha Rao"],
    ["Asha Rao", "Asha Rao Kumar"],
  ]) {
    if (!nameMatches(given, stored)) throw new Error(`rejected "${given}" against "${stored}"`);
  }
});

check("nameMatches refuses a different student", () => {
  // This is what stops one student taking over another's row by typing their
  // address with a fresh mobile number.
  for (const [given, stored] of [
    ["Copycat C", "Asha Rao"],
    ["Shouty S", "Asha Rao"],
    ["Rao", "Asha Rao"], // a surname alone is not enough
    ["Ash", "Asha Rao"], // nor is a prefix of the first name
    ["", "Asha Rao"],
    ["Asha Rao", ""],
  ]) {
    if (nameMatches(given, stored)) throw new Error(`accepted "${given}" against "${stored}"`);
  }
});

/* ------------------------------ formatting ------------------------------- */

check("formatMs reads naturally at each scale", () => {
  eq(formatMs(0), "0.0s");
  eq(formatMs(1500), "1.5s");
  eq(formatMs(59_900), "59.9s");
  eq(formatMs(60_000), "1m 00s");
  eq(formatMs(125_000), "2m 05s");
  eq(formatMs(-10), "0.0s");
});

/* -------------------------------- slugs ---------------------------------- */

check("slugify makes typeable codes", () => {
  eq(slugify("St. Xavier's College — Bengaluru 2026"), "st-xaviers-college-bengaluru-2026");
  eq(slugify("  Spaces   Everywhere  "), "spaces-everywhere");
  eq(slugify("Café Déjà Vu"), "cafe-deja-vu");
  eq(slugify("!!!"), "");
  eq(slugify("UPPER_case-123"), "upper-case-123");
});

check("slugify caps length at 48 characters", () => {
  const long = slugify("a".repeat(80));
  if (long.length !== 48) throw new Error(`length is ${long.length}, expected 48`);
});

/* -------------------------------- phones --------------------------------- */

check("normalizePhone accepts the ways people type Indian numbers", () => {
  eq(normalizePhone("9876543210"), "9876543210");
  eq(normalizePhone("+91 98765 43210"), "9876543210");
  eq(normalizePhone("+91-9876543210"), "9876543210");
  eq(normalizePhone("09876543210"), "9876543210");
  eq(normalizePhone("98765 43210"), "9876543210");
  eq(normalizePhone(null), "");
});

check("phoneField rejects what is not a mobile number", () => {
  for (const good of ["9876543210", "+91 98765 43210", "6000000000"]) {
    if (!phoneField.safeParse(good).success) throw new Error(`rejected valid: ${good}`);
  }
  for (const bad of ["1234567890", "5876543210", "98765", "98765432101", "abcdefghij", ""]) {
    if (phoneField.safeParse(bad).success) throw new Error(`accepted invalid: ${bad}`);
  }
});

/* ------------------------------ names/emails ----------------------------- */

check("nameField trims and collapses whitespace", () => {
  const r = nameField.safeParse("  Asha    Rao  ");
  if (!r.success) throw new Error("rejected a valid name");
  eq(r.data, "Asha Rao");
  if (nameField.safeParse("Al").success) throw new Error("accepted a 2-letter name");
  if (nameField.safeParse("x".repeat(81)).success) throw new Error("accepted an 81-char name");
});

check("emailField lowercases and validates", () => {
  const r = emailField.safeParse("  Asha@Example.COM ");
  if (!r.success) throw new Error("rejected a valid email");
  eq(r.data, "asha@example.com");
  for (const bad of ["no-at-sign", "a@b", "a b@c.com", "@x.com", ""]) {
    if (emailField.safeParse(bad).success) throw new Error(`accepted invalid: ${bad}`);
  }
});

console.log(`\n${failures.length ? "FAILED" : "All good"}: ${pass} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
