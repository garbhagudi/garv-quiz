/**
 * Question wording is plain text that may run to several lines, so a question
 * can carry a list:
 *
 *     Which of these are true of a blastocyst?
 *     - It forms around Day 5-6
 *     - It has an inner cell mass
 *     1. First numbered point
 *
 * A line that opens with a dash, asterisk or bullet character becomes a list
 * item; a line that opens with "1." or "2)" becomes a numbered item; anything
 * else is ordinary wording. Nothing else is interpreted - in particular this is
 * not Markdown and never becomes HTML, so a question is free to contain <, &
 * or a stray asterisk mid-sentence without any of it being dangerous.
 *
 * The parsing lives here, apart from the component that draws it, so the rules
 * can be tested on their own and so both the student's phone and the admin
 * panel show a question the same way.
 */

export type QuestionBlock =
  | { kind: "text"; lines: string[] }
  | { kind: "bullets"; items: string[] }
  | { kind: "numbers"; items: string[] };

/**
 * A list marker, and the two ways one can be followed.
 *
 *   `\s+`               a space after the marker, then anything - "- 21 mm".
 *   `(?=[^\s\d-])`      no space, but a letter or symbol next - "-Estradiol".
 *
 * The second form exists because that is how people actually type a bullet, but
 * it deliberately refuses a digit or another dash after the marker, so a line
 * that opens with a measurement or a rule of dashes stays as wording:
 *
 *   -196°C is the temperature   →  text, not a bullet
 *   ----------                  →  text, not a bullet
 *   - 21 mm follicle            →  a bullet, digits and all
 */
const AFTER_MARKER = String.raw`(?:\s+|(?=[^\s\d-]))`;

/** "- item", "* item", "• item", "· item" - the marker must be followed by text. */
const BULLET = new RegExp(String.raw`^[-*•·‣▪]${AFTER_MARKER}(.*\S)\s*$`);

/**
 * "1. item", "2) item" - at most two digits, so a year cannot start a list, and
 * a digit may not follow the dot, so "1.5 mm" stays wording.
 */
const NUMBER = new RegExp(String.raw`^(\d{1,2})[.)]${AFTER_MARKER}(.*\S)\s*$`);

/**
 * Normalises what an admin typed or pasted: Windows and old-Mac line endings
 * become plain newlines, trailing spaces go, and a wall of blank lines collapses
 * to one gap. Run on the way into the database so every reader sees one shape.
 */
export function normalizeQuestionText(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Splits question wording into the blocks a renderer can lay out. */
export function parseQuestionText(text: string): QuestionBlock[] {
  const blocks: QuestionBlock[] = [];

  for (const rawLine of normalizeQuestionText(text).split("\n")) {
    const line = rawLine.trim();

    // A blank line ends whatever block was open, and adds nothing of its own.
    if (!line) {
      if (blocks.length && blocks[blocks.length - 1].kind === "text") blocks.push({ kind: "text", lines: [] });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBER.exec(line);
    const kind: QuestionBlock["kind"] = bullet ? "bullets" : numbered ? "numbers" : "text";
    const value = bullet ? bullet[1] : numbered ? numbered[2] : line;

    // Consecutive lines of the same kind belong to one block, so three dashes in
    // a row become one list rather than three lists of one.
    const open = blocks[blocks.length - 1];
    if (open && open.kind === kind) {
      if (open.kind === "text") open.lines.push(value);
      else open.items.push(value);
      continue;
    }

    blocks.push(kind === "text" ? { kind, lines: [value] } : { kind, items: [value] });
  }

  // The blank-line marker above can leave an empty text block behind.
  return blocks.filter((b) => (b.kind === "text" ? b.lines.length > 0 : b.items.length > 0));
}

/**
 * True when the wording is a single ordinary line - which nearly every question
 * is. Lets a renderer keep the plain one-paragraph markup it always used, so
 * adding lists changed nothing for questions that do not have one.
 */
export function isPlainQuestionText(text: string): boolean {
  const blocks = parseQuestionText(text);
  return blocks.length <= 1 && (blocks.length === 0 || (blocks[0].kind === "text" && blocks[0].lines.length === 1));
}

/**
 * One-line form, for somewhere a list cannot be drawn: the audit log's label,
 * a confirmation dialog, a spreadsheet cell.
 */
export function flattenQuestionText(text: string): string {
  return parseQuestionText(text)
    .flatMap((b) => (b.kind === "text" ? b.lines : b.items.map((i) => `• ${i}`)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
