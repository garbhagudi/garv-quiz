import { Fragment } from "react";
import { parseQuestionText, isPlainQuestionText } from "@/lib/questionText";

/**
 * Draws question wording, list and all. Used by the student's phone, the admin
 * question bank, the editor's preview and every answer sheet, so a question
 * reads the same everywhere it appears.
 *
 * Font size, colour and weight come from `className` and are inherited by the
 * paragraphs and list items inside, which is what lets the same component sit in
 * a 19.5px quiz screen and a 13.5px table cell without knowing about either.
 *
 * The text is rendered as text. There is no HTML in it and none is produced -
 * see src/lib/questionText.ts.
 */
export function QuestionText({
  text,
  className,
  prefix,
}: {
  text: string;
  className?: string;
  /** e.g. "3." - kept on the same line as the first word, not above it. */
  prefix?: string;
}) {
  const lead = prefix ? `${prefix} ` : "";

  // The overwhelmingly common case: one ordinary line, drawn exactly as it was
  // before lists existed.
  if (isPlainQuestionText(text))
    return (
      <p className={className}>
        {lead}
        {text.trim()}
      </p>
    );

  const blocks = parseQuestionText(text);
  // The prefix normally rides on the first word of the wording. A question that
  // opens straight into a list has no first word, so it gets a line of its own
  // rather than being dropped.
  const orphanPrefix = Boolean(prefix) && blocks[0]?.kind !== "text";

  return (
    <div className={className}>
      {orphanPrefix ? <p>{prefix}</p> : null}
      {blocks.map((block, b) => {
        const spaced = b > 0 || orphanPrefix;

        if (block.kind === "text") {
          const withLead = (line: string, first: boolean) =>
            first && b === 0 && !orphanPrefix ? `${lead}${line}` : line;

          return (
            <p key={b} className={spaced ? "mt-2" : undefined}>
              {block.lines.length === 1
                ? withLead(block.lines[0], true)
                : block.lines.map((line, l) => (
                    // The author's own line breaks, kept as they typed them.
                    <Fragment key={l}>
                      {l > 0 ? <br /> : null}
                      {withLead(line, l === 0)}
                    </Fragment>
                  ))}
            </p>
          );
        }

        const items = block.items.map((item, i) => (
          <li key={i} className="pl-0.5">
            {item}
          </li>
        ));
        const listClass = `mt-1.5 space-y-1 pl-[1.35em] ${
          block.kind === "bullets" ? "list-disc" : "list-decimal"
        }`;

        return block.kind === "bullets" ? (
          <ul key={b} className={listClass}>
            {items}
          </ul>
        ) : (
          <ol key={b} className={listClass}>
            {items}
          </ol>
        );
      })}
    </div>
  );
}
