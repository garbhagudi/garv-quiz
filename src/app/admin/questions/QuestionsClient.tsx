"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errText } from "@/lib/client";
import { PageHead, Chip, Notice, Spinner, Empty, Modal, Field } from "@/components/admin/Ui";
import { QuestionText } from "@/components/QuestionText";
import { flattenQuestionText } from "@/lib/questionText";
import { QuestionEditor, answerKeyOfRow, type QuestionRow } from "./QuestionEditor";

type SetRow = {
  id: number;
  name: string;
  description: string;
  is_archived: boolean;
  /** Whole-quiz limit in seconds; null means the quiz is untimed. */
  time_limit_seconds: number | null;
  question_count: number;
  active_count: number;
  organization_count: number;
};

/** "10 min" / "1 hr 30 min", for the set list and the editor. */
function limitLabel(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} hr ${rest} min` : `${h} hr`;
}

export function QuestionsClient({ canWrite }: { canWrite: boolean }) {
  const [sets, setSets] = useState<SetRow[] | null>(null);
  const [activeSet, setActiveSet] = useState<number | null>(null);
  const [questions, setQuestions] = useState<QuestionRow[] | null>(null);

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState<QuestionRow | "new" | null>(null);
  const [setModal, setSetModal] = useState<SetRow | "new" | null>(null);

  /* ------------------------------- loading ------------------------------- */

  const loadSets = useCallback(async () => {
    try {
      const { sets } = await api<{ sets: SetRow[] }>("/api/admin/sets");
      setSets(sets);
      setActiveSet((cur) => cur ?? sets.find((s) => !s.is_archived)?.id ?? sets[0]?.id ?? null);
      return sets;
    } catch (e) {
      setError(errText(e));
      setSets([]);
      return [];
    }
  }, []);

  const loadQuestions = useCallback(async (setId: number) => {
    setQuestions(null);
    try {
      const { questions } = await api<{ questions: QuestionRow[] }>(
        `/api/admin/questions?setId=${setId}`,
      );
      setQuestions(questions);
    } catch (e) {
      setError(errText(e));
      setQuestions([]);
    }
  }, []);

  useEffect(() => {
    void loadSets();
  }, [loadSets]);

  useEffect(() => {
    if (activeSet) void loadQuestions(activeSet);
  }, [activeSet, loadQuestions]);

  const current = sets?.find((s) => s.id === activeSet) ?? null;

  /* ------------------------------ reordering ----------------------------- */

  async function move(index: number, delta: number) {
    if (!questions || !activeSet) return;
    const target = index + delta;
    if (target < 0 || target >= questions.length) return;

    const next = [...questions];
    [next[index], next[target]] = [next[target], next[index]];
    setQuestions(next); // optimistic - the list is the source of truth for order

    setSaving(true);
    try {
      await api("/api/admin/questions", {
        method: "PUT",
        body: { setId: activeSet, order: next.map((q) => q.id) },
      });
    } catch (e) {
      setError(errText(e));
      void loadQuestions(activeSet);
    } finally {
      setSaving(false);
    }
  }

  // PATCH replaces the whole row, so every field has to be sent back - leaving
  // one out would quietly wipe the answer key or the picture off a question
  // that was only meant to be hidden.
  async function toggleActive(q: QuestionRow) {
    if (!activeSet) return;
    try {
      await api(`/api/admin/questions/${q.id}`, {
        method: "PATCH",
        body: {
          setId: q.set_id,
          text: q.text,
          options: q.options,
          correctIndexes: answerKeyOfRow(q),
          imageUrl: q.image_url ?? "",
          imageAlt: q.image_alt ?? "",
          explanation: q.explanation,
          points: q.points,
          isActive: !q.is_active,
        },
      });
      void loadQuestions(activeSet);
      void loadSets();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function remove(q: QuestionRow) {
    if (!activeSet) return;
    // A confirm dialog cannot draw a list, so show the one-line form of it.
    if (!window.confirm(`Delete this question?\n\n${flattenQuestionText(q.text)}`)) return;
    try {
      await api(`/api/admin/questions/${q.id}`, { method: "DELETE" });
      setNotice("Question deleted.");
      void loadQuestions(activeSet);
      void loadSets();
    } catch (e) {
      setError(errText(e));
    }
  }

  /* -------------------------------- render ------------------------------- */

  return (
    <>
      <PageHead
        eyebrow="Question bank"
        title="Questions"
        sub="Edits go live at once. Quizzes already submitted keep the wording they were marked against."
        actions={
          canWrite ? (
            <>
              <button className="btn-ghost btn-sm" onClick={() => setSetModal("new")}>
                New set
              </button>
              <button
                className="btn-accent btn-sm"
                onClick={() => setEditing("new")}
                disabled={!activeSet}
              >
                Add question
              </button>
            </>
          ) : (
            <Chip>View only</Chip>
          )
        }
      />

      <Notice tone="good">{notice}</Notice>
      <Notice tone="warn">{error}</Notice>

      <div className="grid gap-4 lg:grid-cols-4">
        {/* ------------------------------ sets ---------------------------- */}
        <aside className="panel lg:col-span-1">
          <h2 className="mb-3 font-display text-[15px] font-medium text-plum">Question sets</h2>
          {sets === null ? (
            <Spinner />
          ) : sets.length === 0 ? (
            <Empty>No sets yet.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {sets.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => setActiveSet(s.id)}
                    className={[
                      "w-full rounded-[12px] border-[1.5px] px-3 py-2.5 text-left transition",
                      activeSet === s.id
                        ? "border-plum/40 bg-petal"
                        : "border-ink/10 bg-surface hover:border-plum/25",
                    ].join(" ")}
                  >
                    <span className="block font-display text-[14px] font-medium leading-snug text-ink">
                      {s.name}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-muted">
                      {s.active_count} active
                      {s.question_count !== s.active_count ? ` of ${s.question_count}` : ""} ·{" "}
                      {s.organization_count} organization{s.organization_count === 1 ? "" : "s"}
                      {s.time_limit_seconds ? ` · ${limitLabel(s.time_limit_seconds)}` : ""}
                    </span>
                    {s.is_archived ? <Chip>Archived</Chip> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {current && canWrite ? (
            <div className="mt-3.5 flex flex-wrap gap-x-3 gap-y-1.5 border-t border-ink/10 pt-3">
              <button className="linkish" onClick={() => setSetModal(current)}>
                Rename / archive
              </button>
              <button
                className="linkish"
                onClick={async () => {
                  try {
                    await api("/api/admin/sets", {
                      body: {
                        name: `${current.name} (copy)`,
                        description: current.description,
                        // A copy of a timed set is still timed, or duplicating
                        // one silently drops its limit.
                        timeLimitMinutes: current.time_limit_seconds
                          ? Math.round(current.time_limit_seconds / 60)
                          : null,
                        copyFrom: current.id,
                      },
                    });
                    setNotice(`Duplicated “${current.name}”.`);
                    void loadSets();
                  } catch (e) {
                    setError(errText(e));
                  }
                }}
              >
                Duplicate
              </button>
              <button
                className="linkish text-coral"
                onClick={async () => {
                  if (!window.confirm(`Delete the set “${current.name}” and all its questions?`))
                    return;
                  try {
                    await api(`/api/admin/sets/${current.id}`, { method: "DELETE" });
                    setNotice(`Deleted “${current.name}”.`);
                    setActiveSet(null);
                    void loadSets();
                  } catch (e) {
                    setError(errText(e));
                  }
                }}
              >
                Delete set
              </button>
            </div>
          ) : null}
        </aside>

        {/* --------------------------- questions -------------------------- */}
        <section className="panel lg:col-span-3">
          {current ? (
            <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="font-display text-[16px] font-medium text-plum">{current.name}</h2>
                {current.description ? (
                  <p className="mt-0.5 text-[13px] leading-snug text-muted">{current.description}</p>
                ) : null}
                <p className="mt-1 text-[12.5px] text-muted">
                  {current.time_limit_seconds
                    ? `Timed: ${limitLabel(current.time_limit_seconds)} for the whole quiz`
                    : "Untimed - students take as long as they like"}
                </p>
              </div>
              {saving ? <span className="text-[12.5px] text-muted">Saving order…</span> : null}
            </div>
          ) : null}

          {questions === null ? (
            <Spinner label="Loading questions…" />
          ) : questions.length === 0 ? (
            <Empty>
              {current ? (
                canWrite ? (
                  <>
                    This set has no questions.{" "}
                    <button className="linkish" onClick={() => setEditing("new")}>
                      Add the first one
                    </button>
                    .
                  </>
                ) : (
                  "This set has no questions."
                )
              ) : (
                "Pick a question set."
              )}
            </Empty>
          ) : (
            <ol className="space-y-2.5">
              {questions.map((q, i) => (
                <li
                  key={q.id}
                  className={[
                    "rounded-xl2 border-[1.5px] p-3.5",
                    q.is_active ? "border-ink/10 bg-surface" : "border-ink/10 bg-ink/[0.03] opacity-70",
                  ].join(" ")}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex shrink-0 flex-col items-center gap-0.5">
                      <span className="font-display text-[12px] font-bold tabular-nums text-plum-soft">
                        {i + 1}
                      </span>
                      {canWrite ? (
                        <>
                          <button
                            className="grid h-6 w-6 place-items-center rounded text-[11px] text-muted hover:bg-petal hover:text-plum disabled:opacity-30"
                            onClick={() => void move(i, -1)}
                            disabled={i === 0 || saving}
                            aria-label="Move up"
                          >
                            ▲
                          </button>
                          <button
                            className="grid h-6 w-6 place-items-center rounded text-[11px] text-muted hover:bg-petal hover:text-plum disabled:opacity-30"
                            onClick={() => void move(i, 1)}
                            disabled={i === questions.length - 1 || saving}
                            aria-label="Move down"
                          >
                            ▼
                          </button>
                        </>
                      ) : null}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start gap-3">
                        {q.image_url ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            src={q.image_url}
                            alt={q.image_alt || "Question picture"}
                            className="h-16 w-16 shrink-0 rounded-[10px] border border-ink/10 bg-surface object-contain"
                          />
                        ) : null}
                        <QuestionText
                          text={q.text}
                          className="min-w-[12rem] flex-1 font-display text-[15px] font-medium leading-snug text-ink"
                        />
                      </div>
                      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                        {q.options.map((o, k) => {
                          const right = answerKeyOfRow(q).includes(k);
                          return (
                            <li
                              key={k}
                              className={[
                                "flex items-start gap-1.5 rounded-lg px-2 py-1 text-[13px] leading-snug",
                                right ? "bg-moss/10 font-semibold text-moss" : "text-sub",
                              ].join(" ")}
                            >
                              <span className="font-display text-[11px] font-bold opacity-70">
                                {"ABCDEFGH"[k]}
                              </span>
                              <span>{o}</span>
                              {right ? <span aria-hidden="true">✓</span> : null}
                            </li>
                          );
                        })}
                      </ul>

                      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                        <span>{q.points} pt{q.points === 1 ? "" : "s"}</span>
                        {answerKeyOfRow(q).length > 1 ? (
                          <Chip tone="info">Select all that apply</Chip>
                        ) : null}
                        {q.times_asked > 0 ? (
                          <span>
                            asked {q.times_asked}× ·{" "}
                            {Math.round((q.times_right / q.times_asked) * 100)}% correct
                          </span>
                        ) : (
                          <span>never asked yet</span>
                        )}
                        {!q.is_active ? <Chip tone="warn">Hidden</Chip> : null}
                        {canWrite ? (
                          <>
                            <button className="linkish" onClick={() => setEditing(q)}>
                              Edit
                            </button>
                            <button className="linkish" onClick={() => void toggleActive(q)}>
                              {q.is_active ? "Hide" : "Show"}
                            </button>
                            <button className="linkish text-coral" onClick={() => void remove(q)}>
                              Delete
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {editing && activeSet ? (
        <QuestionEditor
          setId={activeSet}
          question={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setNotice(msg);
            void loadQuestions(activeSet);
            void loadSets();
          }}
        />
      ) : null}

      {setModal ? (
        <SetModal
          set={setModal === "new" ? null : setModal}
          onClose={() => setSetModal(null)}
          onSaved={(msg, id) => {
            setSetModal(null);
            setNotice(msg);
            void loadSets().then(() => {
              if (id) setActiveSet(id);
            });
          }}
        />
      ) : null}
    </>
  );
}

/* ---------------------------- create / rename set ------------------------ */

function SetModal({
  set,
  onClose,
  onSaved,
}: {
  set: SetRow | null;
  onClose: () => void;
  onSaved: (message: string, id?: number) => void;
}) {
  const [name, setName] = useState(set?.name ?? "");
  const [description, setDescription] = useState(set?.description ?? "");
  const [isArchived, setIsArchived] = useState(set?.is_archived ?? false);
  // Held as the string the box contains, so it can be emptied to mean "no limit".
  const [limitMinutes, setLimitMinutes] = useState(
    set?.time_limit_seconds ? String(Math.round(set.time_limit_seconds / 60)) : "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const trimmed = limitMinutes.trim();
    if (trimmed !== "") {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 1 || n > 360)
        return setError(
          "Set a whole number of minutes between 1 and 360, or leave it blank for no limit.",
        );
    }

    setBusy(true);
    try {
      const res = await api<{ set: { id: number } }>(
        set ? `/api/admin/sets/${set.id}` : "/api/admin/sets",
        {
          method: set ? "PATCH" : "POST",
          body: { name, description, isArchived, timeLimitMinutes: trimmed === "" ? null : trimmed },
        },
      );
      onSaved(set ? "Set updated." : `Created “${name}”.`, res.set?.id);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={set ? "Edit question set" : "New question set"} onClose={onClose}>
      <form onSubmit={save} noValidate className="space-y-3">
        <Field label="Name">
          <input
            className="input-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Embryology Quiz Challenge"
          />
        </Field>
        <Field label="Description" hint="Only staff see this.">
          <input
            className="input-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field
          label="Time limit (minutes)"
          hint={
            limitMinutes.trim() === ""
              ? "Leave blank for no limit - students take as long as they like."
              : "For the whole quiz. The countdown runs on the student's screen and submits their answers automatically when it reaches zero."
          }
        >
          <input
            className="input-sm"
            type="number"
            min={1}
            max={360}
            inputMode="numeric"
            placeholder="No limit"
            value={limitMinutes}
            onChange={(e) => setLimitMinutes(e.target.value)}
          />
        </Field>
        {set ? (
          <label className="flex items-center gap-2.5 text-[14px] text-ink">
            <input
              type="checkbox"
              className="h-[18px] w-[18px] accent-plum"
              checked={isArchived}
              onChange={(e) => setIsArchived(e.target.checked)}
            />
            Archived - hide from the default choices when creating an organization
          </label>
        ) : null}

        <Notice tone="warn">{error}</Notice>

        <div className="flex flex-wrap gap-2.5 pt-1">
          <button type="submit" className="btn-primary btn-sm" disabled={busy}>
            {busy ? "Saving…" : set ? "Save" : "Create set"}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
