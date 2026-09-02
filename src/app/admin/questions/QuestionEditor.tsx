"use client";

import { useRef, useState } from "react";
import { api, upload, errText } from "@/lib/client";
import { Modal, Field, Notice, Chip } from "@/components/admin/Ui";
import { QuestionText } from "@/components/QuestionText";
import { isPlainQuestionText, normalizeQuestionText } from "@/lib/questionText";

export type QuestionRow = {
  id: number;
  set_id: number;
  position: number;
  text: string;
  options: string[];
  correct_index: number;
  correct_indexes: number[] | null;
  image_url: string;
  image_alt: string;
  explanation: string;
  points: number;
  is_active: boolean;
  times_asked: number;
  times_right: number;
};

const MAX_OPTIONS = 8;
const LETTERS = "ABCDEFGH";

/**
 * The answer key of a stored row. `correct_indexes` is the real key; a row that
 * predates it — or one seeded by hand-written SQL — falls back to the single
 * `correct_index`, exactly as the server does when marking.
 */
export function answerKeyOfRow(q: {
  correct_indexes?: number[] | null;
  correct_index: number;
}): number[] {
  const keys = q.correct_indexes?.length ? q.correct_indexes.map(Number) : [Number(q.correct_index)];
  return [...new Set(keys)].sort((a, b) => a - b);
}

/**
 * Add or edit one question.
 *
 * The correct answers are ticked with checkboxes rather than picked with a
 * radio, so a question can have several right options. Removing an option
 * shifts the key with it, which makes it impossible to save a question whose
 * answer key points at an option that no longer exists.
 *
 * A picture is optional. Choosing a file uploads it straight away and stores
 * the path, so the question row only ever holds a short URL.
 */
export function QuestionEditor({
  setId,
  question,
  onClose,
  onSaved,
}: {
  setId: number;
  question: QuestionRow | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [text, setText] = useState(question?.text ?? "");
  const [options, setOptions] = useState<string[]>(
    question?.options?.length ? [...question.options] : ["", "", "", ""],
  );
  const [correct, setCorrect] = useState<number[]>(
    question ? answerKeyOfRow(question) : [0],
  );
  const [imageUrl, setImageUrl] = useState(question?.image_url ?? "");
  const [imageAlt, setImageAlt] = useState(question?.image_alt ?? "");
  const [explanation, setExplanation] = useState(question?.explanation ?? "");
  const [points, setPoints] = useState(question?.points ?? 1);
  const [isActive, setIsActive] = useState(question?.is_active ?? true);

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const questionBox = useRef<HTMLTextAreaElement>(null);

  /**
   * Starts a fresh bullet line at the end of the wording and puts the cursor
   * after the dash, so somebody who has not spotted the convention can find it
   * by clicking once.
   */
  function addBulletLine() {
    const base = text.replace(/\s+$/, "");
    const next = `${base}${base ? "\n" : ""}- `;
    setText(next);
    // Focus after React has painted the new value, or the caret lands mid-string.
    requestAnimationFrame(() => {
      const box = questionBox.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(next.length, next.length);
      box.scrollTop = box.scrollHeight;
    });
  }

  const isCorrect = (i: number) => correct.includes(i);

  function toggleCorrect(i: number) {
    setCorrect((cur) =>
      cur.includes(i) ? cur.filter((k) => k !== i) : [...cur, i].sort((a, b) => a - b),
    );
  }

  function setOption(i: number, value: string) {
    const next = [...options];
    next[i] = value;
    setOptions(next);
  }

  function addOption() {
    if (options.length >= MAX_OPTIONS) return;
    setOptions([...options, ""]);
  }

  function removeOption(i: number) {
    if (options.length <= 2) return;
    setOptions(options.filter((_, k) => k !== i));
    // Keep the key pointing at the same options after the list shifts up.
    setCorrect((cur) => cur.filter((k) => k !== i).map((k) => (k > i ? k - 1 : k)));
  }

  /* ------------------------------- picture ------------------------------- */

  async function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Let the same file be chosen again after a failure or a removal.
    e.target.value = "";
    if (!file) return;

    setError("");
    setUploading(true);
    try {
      const { url } = await upload<{ url: string }>("/api/admin/uploads", file);
      setImageUrl(url);
      // A picture with no description is unreadable to a screen reader, so seed
      // one from the filename — the wording is still the editor's to improve.
      if (!imageAlt.trim()) setImageAlt(file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 200));
    } catch (err) {
      setError(errText(err));
    } finally {
      setUploading(false);
    }
  }

  /* -------------------------------- save --------------------------------- */

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const cleaned = options.map((o) => o.trim());
    const wording = normalizeQuestionText(text);
    if (wording.length < 5) return setError("Write the question.");
    if (wording.length > 2000)
      return setError("That question is too long — keep it under 2000 characters.");
    if (wording.split("\n").length > 40)
      return setError("That is a lot of lines for one question — keep it under 40.");
    if (cleaned.some((o) => !o)) return setError("Fill in every option, or remove the blank ones.");
    if (new Set(cleaned.map((o) => o.toLowerCase())).size !== cleaned.length)
      return setError("Two options are identical.");
    if (!correct.length) return setError("Tick the option — or options — that are correct.");
    if (correct.some((i) => i >= cleaned.length)) return setError("Mark which option is correct.");
    if (correct.length === cleaned.length)
      return setError("Every option cannot be correct — there would be nothing to work out.");
    if (imageUrl && !imageAlt.trim())
      return setError("Describe the picture, so it still makes sense on a screen reader.");

    setBusy(true);
    try {
      await api(question ? `/api/admin/questions/${question.id}` : "/api/admin/questions", {
        method: question ? "PATCH" : "POST",
        body: {
          setId,
          text: wording,
          options: cleaned,
          correctIndexes: correct,
          imageUrl,
          imageAlt: imageAlt.trim(),
          explanation: explanation.trim(),
          points,
          isActive,
        },
      });
      onSaved(question ? "Question updated." : "Question added.");
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  /* -------------------------------- render ------------------------------- */

  return (
    <Modal title={question ? "Edit question" : "New question"} onClose={onClose} wide>
      <form onSubmit={save} noValidate>
        <Field label="Question">
          <textarea
            ref={questionBox}
            className="input-sm min-h-[104px] resize-y font-normal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "Which of these are true of a blastocyst?\n- It forms around Day 5–6\n- It has an inner cell mass"
            }
          />
        </Field>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" className="linkish" onClick={addBulletLine}>
            + Add a bullet point
          </button>
          <p className="text-[12px] leading-snug text-muted">
            Start a line with <code className="font-semibold">-</code> for a bullet, or{" "}
            <code className="font-semibold">1.</code> for a numbered list. Everything else is
            ordinary wording.
          </p>
        </div>

        {/* Only worth the space once the wording is more than one plain line. */}
        {!isPlainQuestionText(text) ? (
          <div className="mt-2.5 rounded-[12px] border-[1.5px] border-dashed border-ink/15 bg-surface px-3.5 py-3">
            <p className="mb-1.5 font-display text-[11px] font-medium uppercase tracking-[0.1em] text-plum-soft">
              How the student will see it
            </p>
            <QuestionText
              text={text}
              className="font-display text-[15.5px] font-medium leading-[1.35] text-ink"
            />
          </div>
        ) : null}

        {/* ------------------------------ picture --------------------------- */}
        <div className="mt-4 rounded-[14px] border-[1.5px] border-ink/10 bg-ink/[0.015] p-3.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="font-display text-[11.5px] font-medium uppercase tracking-[0.1em] text-plum-soft">
              Picture — optional
            </p>
            {imageUrl ? <Chip tone="good">Attached</Chip> : null}
          </div>

          {imageUrl ? (
            <div className="flex flex-wrap items-start gap-3.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt={imageAlt || "Question picture"}
                className="max-h-[130px] w-auto max-w-full rounded-[11px] border border-ink/10 bg-surface object-contain"
              />
              <div className="min-w-[200px] flex-1">
                <Field label="What the picture shows" hint="Read out instead of the picture if it cannot load.">
                  <input
                    className="input-sm font-normal"
                    value={imageAlt}
                    onChange={(e) => setImageAlt(e.target.value)}
                    placeholder="Day-5 blastocyst under the microscope"
                  />
                </Field>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => fileInput.current?.click()}
                    disabled={uploading}
                  >
                    Replace picture
                  </button>
                  <button
                    type="button"
                    className="linkish text-coral"
                    onClick={() => {
                      setImageUrl("");
                      setImageAlt("");
                    }}
                    disabled={uploading}
                  >
                    Remove picture
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
              >
                {uploading ? "Uploading…" : "Choose a picture"}
              </button>
              <p className="mt-2 text-[12px] leading-snug text-muted">
                PNG, JPEG, WebP or GIF, up to 2 MB. It appears above the question on the student’s
                phone. You can also paste a link:
              </p>
              <input
                className="input-sm mt-1.5 font-normal"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://…"
                disabled={uploading}
              />
            </>
          )}

          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            onChange={(e) => void pickImage(e)}
          />
        </div>

        {/* ------------------------------ options --------------------------- */}
        <div className="mt-4">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <p className="font-display text-[11.5px] font-medium uppercase tracking-[0.1em] text-plum-soft">
              Options — tick every correct one
            </p>
            {correct.length === 0 ? (
              <Chip tone="warn">Nothing ticked</Chip>
            ) : correct.length > 1 ? (
              <Chip tone="info">{correct.length} correct answers</Chip>
            ) : null}
          </div>
          <div className="space-y-2">
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <label
                  className={[
                    "grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-[11px] border-[1.5px] font-display text-[12.5px] font-bold transition",
                    isCorrect(i)
                      ? "border-moss bg-moss-fill text-white"
                      : "border-ink/15 bg-surface text-plum-soft hover:border-moss/50",
                  ].join(" ")}
                  title="Tick if this option is correct"
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={isCorrect(i)}
                    onChange={() => toggleCorrect(i)}
                  />
                  {isCorrect(i) ? "✓" : LETTERS[i]}
                </label>
                <input
                  className="input-sm font-normal"
                  value={o}
                  onChange={(e) => setOption(i, e.target.value)}
                  placeholder={`Option ${LETTERS[i]}`}
                />
                <button
                  type="button"
                  onClick={() => removeOption(i)}
                  disabled={options.length <= 2}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] text-[15px] text-muted hover:bg-coral/10 hover:text-coral disabled:opacity-25"
                  aria-label={`Remove option ${LETTERS[i]}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          {options.length < MAX_OPTIONS ? (
            <button type="button" className="linkish mt-2" onClick={addOption}>
              + Add another option
            </button>
          ) : null}
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            {correct.length === 0 ? (
              <>
                <b className="text-coral">Tick at least one correct option.</b> Removing the option
                that was marked correct leaves the question unanswerable.{" "}
              </>
            ) : null}
            Option order is shuffled per student, so A here is only your typing order.
            {correct.length > 1 ? (
              <>
                {" "}
                With more than one correct option the student is asked to select all that apply, and
                only the exact set scores — half right earns nothing.
              </>
            ) : null}
          </p>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Points">
            <input
              className="input-sm"
              type="number"
              min={1}
              max={100}
              value={points}
              onChange={(e) => setPoints(Math.max(1, Number(e.target.value) || 1))}
            />
          </Field>
          <Field label="Explanation" hint="Internal only — never shown to students.">
            <input
              className="input-sm font-normal"
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
            />
          </Field>
        </div>

        <label className="mt-3 flex items-center gap-2.5 text-[14px] text-ink">
          <input
            type="checkbox"
            className="h-[18px] w-[18px] accent-plum"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          Include this question in quizzes
        </label>

        {question && question.times_asked > 0 ? (
          <p className="mt-3 rounded-[12px] bg-petal px-3.5 py-2.5 text-[12.5px] leading-relaxed text-plum">
            Asked {question.times_asked} time{question.times_asked === 1 ? "" : "s"} already. Editing
            it will not change how those quizzes were marked.
          </p>
        ) : null}

        <div className="mt-4">
          <Notice tone="warn">{error}</Notice>
        </div>

        <div className="flex flex-wrap gap-2.5">
          <button type="submit" className="btn-primary btn-sm" disabled={busy || uploading}>
            {busy ? "Saving…" : question ? "Save question" : "Add question"}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
