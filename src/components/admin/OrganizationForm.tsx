"use client";

import { useState } from "react";
import { api, errText } from "@/lib/client";
import { Field, Toggle, Notice } from "./Ui";
import type { Organization } from "@/lib/types";

export type SetOption = { id: number; name: string; active_count: number; is_archived: boolean };

/** Mirrors `organizationSchema` on the server, in the camelCase the API expects. */
export type OrganizationDraft = {
  name: string;
  slug: string;
  city: string;
  contactName: string;
  contactPhone: string;
  eventDate: string;
  notes: string;
  questionSetId: number | null;
  isOpen: boolean;
  questionCount: number | null;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  allowRetake: boolean;
  showScore: boolean;
  showLeaderboard: boolean;
  requireEmail: boolean;
  collectClass: boolean;
  prizeNote: string;
};

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

export const blankDraft = (defaultSetId: number | null): OrganizationDraft => ({
  name: "",
  slug: "",
  city: "",
  contactName: "",
  contactPhone: "",
  eventDate: "",
  notes: "",
  questionSetId: defaultSetId,
  isOpen: true,
  questionCount: null,
  shuffleQuestions: false,
  shuffleOptions: true,
  allowRetake: false,
  showScore: true,
  showLeaderboard: true,
  requireEmail: true,
  collectClass: false,
  prizeNote: "Winners get exciting gifts from the GarbhaGudi team.",
});

export const draftFromOrganization = (s: Organization): OrganizationDraft => ({
  name: s.name,
  slug: s.slug,
  city: s.city,
  contactName: s.contact_name,
  contactPhone: s.contact_phone,
  eventDate: s.event_date ? String(s.event_date).slice(0, 10) : "",
  notes: s.notes,
  questionSetId: s.question_set_id,
  isOpen: s.is_open,
  questionCount: s.question_count,
  shuffleQuestions: s.shuffle_questions,
  shuffleOptions: s.shuffle_options,
  allowRetake: s.allow_retake,
  showScore: s.show_score,
  showLeaderboard: s.show_leaderboard,
  requireEmail: s.require_email,
  collectClass: s.collect_class,
  prizeNote: s.prize_note,
});

/**
 * Create/edit form for an organization. `slug` is the code students type, so it is
 * shown prominently and auto-derived from the name until the user edits it.
 */
export function OrganizationForm({
  draft,
  setDraft,
  sets,
  organizationId,
  onSaved,
  onCancel,
  readOnly,
}: {
  draft: OrganizationDraft;
  setDraft: (d: OrganizationDraft) => void;
  sets: SetOption[];
  organizationId?: number;
  onSaved: (organization: Organization) => void;
  onCancel: () => void;
  readOnly?: boolean;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [slugTouched, setSlugTouched] = useState(!!organizationId);

  const set = <K extends keyof OrganizationDraft>(k: K, v: OrganizationDraft[K]) =>
    setDraft({ ...draft, [k]: v });

  const chosenSet = sets.find((s) => s.id === draft.questionSetId);
  const available = chosenSet?.active_count ?? 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (draft.name.trim().length < 3) return setError("Enter the organization name.");
    if (draft.slug.length < 3) return setError("The event code needs at least 3 characters.");
    if (!draft.questionSetId) return setError("Pick which question set this organization will use.");

    setBusy(true);
    try {
      const res = await api<{ organization: Organization }>(
        organizationId ? `/api/admin/organizations/${organizationId}` : "/api/admin/organizations",
        { method: organizationId ? "PATCH" : "POST", body: draft },
      );
      onSaved(res.organization);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} noValidate>
      <Notice tone="warn">{error}</Notice>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Organization name">
          <input
            className="input-sm"
            value={draft.name}
            disabled={readOnly}
            onChange={(e) => {
              const name = e.target.value;
              setDraft({
                ...draft,
                name,
                slug: slugTouched ? draft.slug : slugify(name),
              });
            }}
            placeholder="St. Xavier's College"
          />
        </Field>

        <Field label="Event code (students type this)" hint="Short enough to type without typos.">
          <input
            className="input-sm font-mono"
            value={draft.slug}
            disabled={readOnly}
            onChange={(e) => {
              setSlugTouched(true);
              set("slug", slugify(e.target.value));
            }}
            placeholder="xavier2026"
          />
        </Field>

        <Field label="City">
          <input
            className="input-sm"
            value={draft.city}
            disabled={readOnly}
            onChange={(e) => set("city", e.target.value)}
            placeholder="Bengaluru"
          />
        </Field>

        <Field label="Event date">
          <input
            className="input-sm"
            type="date"
            value={draft.eventDate}
            disabled={readOnly}
            onChange={(e) => set("eventDate", e.target.value)}
          />
        </Field>

        <Field label="Host contact name">
          <input
            className="input-sm"
            value={draft.contactName}
            disabled={readOnly}
            onChange={(e) => set("contactName", e.target.value)}
          />
        </Field>

        <Field label="Host contact number">
          <input
            className="input-sm"
            value={draft.contactPhone}
            disabled={readOnly}
            onChange={(e) => set("contactPhone", e.target.value)}
          />
        </Field>
      </div>

      <h3 className="mb-2 mt-5 font-display text-[13px] font-medium uppercase tracking-[0.12em] text-plum-soft">
        The quiz
      </h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Question set">
          <select
            className="input-sm"
            value={draft.questionSetId ?? ""}
            disabled={readOnly}
            onChange={(e) => set("questionSetId", e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">— choose a set —</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.active_count} question{s.active_count === 1 ? "" : "s"})
                {s.is_archived ? " · archived" : ""}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="How many questions to ask"
          hint={
            available
              ? `Leave blank to ask all ${available}. A smaller number is picked at random per student.`
              : "Pick a question set first."
          }
        >
          <input
            className="input-sm"
            type="number"
            min={1}
            max={available || undefined}
            value={draft.questionCount ?? ""}
            disabled={readOnly}
            onChange={(e) => set("questionCount", e.target.value ? Number(e.target.value) : null)}
            placeholder={available ? `all ${available}` : ""}
          />
        </Field>
      </div>

      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        <Toggle
          label="Accepting entries"
          hint="Closing also unlocks the answer review for students."
          checked={draft.isOpen}
          disabled={readOnly}
          onChange={(v) => set("isOpen", v)}
        />
        <Toggle
          label="Shuffle option order"
          checked={draft.shuffleOptions}
          disabled={readOnly}
          onChange={(v) => set("shuffleOptions", v)}
        />
        <Toggle
          label="Shuffle question order"
          checked={draft.shuffleQuestions}
          disabled={readOnly}
          onChange={(v) => set("shuffleQuestions", v)}
        />
        <Toggle
          label="Allow more than one attempt"
          hint="Off means one attempt per mobile number."
          checked={draft.allowRetake}
          disabled={readOnly}
          onChange={(v) => set("allowRetake", v)}
        />
        <Toggle
          label="Show students their score"
          hint="Off keeps scores secret until you announce them."
          checked={draft.showScore}
          disabled={readOnly}
          onChange={(v) => set("showScore", v)}
        />
        <Toggle
          label="Show the public leaderboard"
          hint="Names and points only — never times or contact details."
          checked={draft.showLeaderboard}
          disabled={readOnly}
          onChange={(v) => set("showLeaderboard", v)}
        />
        <Toggle
          label="Require an email address"
          checked={draft.requireEmail}
          disabled={readOnly}
          onChange={(v) => set("requireEmail", v)}
        />
        <Toggle
          label="Ask for class / year / branch"
          checked={draft.collectClass}
          disabled={readOnly}
          onChange={(v) => set("collectClass", v)}
        />
      </div>

      <div className="mt-3 grid gap-3">
        <Field label="Prize note shown to students">
          <input
            className="input-sm"
            value={draft.prizeNote}
            disabled={readOnly}
            onChange={(e) => set("prizeNote", e.target.value)}
          />
        </Field>
        <Field label="Internal notes">
          <textarea
            className="input-sm min-h-[70px] resize-y"
            value={draft.notes}
            disabled={readOnly}
            onChange={(e) => set("notes", e.target.value)}
          />
        </Field>
      </div>

      {!readOnly ? (
        <div className="mt-5 flex flex-wrap gap-2.5">
          <button type="submit" className="btn-primary btn-sm" disabled={busy}>
            {busy ? "Saving…" : organizationId ? "Save changes" : "Create organization"}
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        <p className="mt-5 text-[13px] text-muted">
          Your account has view-only access, so these settings cannot be changed.
        </p>
      )}
    </form>
  );
}
