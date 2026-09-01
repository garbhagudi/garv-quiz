"use client";

import { useEffect, type ReactNode } from "react";

/* ------------------------------ page header ------------------------------ */

export function PageHead({
  eyebrow,
  title,
  sub,
  actions,
}: {
  eyebrow?: string;
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-1 text-plum-soft">{eyebrow}</p> : null}
        <h1 className="font-display text-[26px] font-bold leading-tight tracking-[-0.01em] text-plum">
          {title}
        </h1>
        {sub ? <p className="mt-1 text-[14.5px] leading-relaxed text-[#5B486F]">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* -------------------------------- stat row ------------------------------- */

export function Stats({
  items,
}: {
  items: {
    label: string;
    value: ReactNode;
    sub?: string;
    tone?: "plain" | "good" | "warn";
    /** Makes the tile a button — for a number that has a list behind it. */
    onClick?: () => void;
  }[];
}) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((s) => {
        const Tile = s.onClick ? "button" : "div";
        return (
        <Tile
          key={s.label}
          onClick={s.onClick}
          className={[
            "rounded-xl2 border border-ink/10 bg-white px-3.5 py-3 text-left",
            s.onClick ? "cursor-pointer transition hover:border-plum/40 hover:bg-petal" : "",
          ].join(" ")}
        >
          <div
            className={[
              "font-display text-[22px] font-bold leading-none tabular-nums",
              s.tone === "good" ? "text-moss" : s.tone === "warn" ? "text-coral" : "text-plum",
            ].join(" ")}
          >
            {s.value}
          </div>
          <div className="mt-1.5 font-display text-[10.5px] font-medium uppercase tracking-[0.12em] text-plum-soft">
            {s.label}
          </div>
          {s.sub ? (
            <div className={`text-[11.5px] ${s.onClick ? "text-plum underline underline-offset-2" : "text-muted"}`}>
              {s.sub}
            </div>
          ) : null}
        </Tile>
        );
      })}
    </div>
  );
}

/* --------------------------------- chips --------------------------------- */

export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "info";
  children: ReactNode;
}) {
  const tones = {
    neutral: "bg-ink/[0.07] text-plum-soft",
    good: "bg-moss/15 text-moss",
    warn: "bg-coral/15 text-coral",
    info: "bg-apricot/20 text-apricot-deep",
  };
  return <span className={`chip ${tones[tone]}`}>{children}</span>;
}

/** One event's state, worded and coloured the same way on every screen. */
const STATUS = {
  closed: { label: "Closed", tone: "neutral" },
  "waiting-room": { label: "Waiting room", tone: "info" },
  live: { label: "Live", tone: "good" },
  over: { label: "Round over", tone: "neutral" },
  open: { label: "Open", tone: "good" },
} as const;

export function EventChip({
  status,
  note,
}: {
  status: keyof typeof STATUS;
  /** Appended after a dot - a countdown, on the screens that tick. */
  note?: string;
}) {
  const { label, tone } = STATUS[status];
  return (
    <Chip tone={tone}>
      {label}
      {note ? ` · ${note}` : ""}
    </Chip>
  );
}

/* -------------------------------- feedback ------------------------------- */

export const Notice = ({
  tone = "info",
  children,
}: {
  tone?: "info" | "good" | "warn";
  children: ReactNode;
}) => {
  if (!children) return null;
  const tones = {
    info: "border-plum/20 bg-petal text-plum",
    good: "border-moss/30 bg-moss/10 text-moss",
    warn: "border-coral/30 bg-coral/10 text-coral",
  };
  return (
    <p
      role="status"
      className={`mb-4 rounded-[14px] border px-3.5 py-2.5 text-[14px] font-semibold leading-relaxed ${tones[tone]}`}
    >
      {children}
    </p>
  );
};

export const Spinner = ({ label = "Loading…" }: { label?: string }) => (
  <div className="flex items-center gap-2.5 py-8 text-plum-soft">
    <span className="h-3.5 w-3.5 animate-pulseDot rounded-full bg-apricot" />
    <span className="font-display text-[14.5px]">{label}</span>
  </div>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="rounded-xl2 border border-dashed border-ink/15 px-4 py-8 text-center text-[14.5px] text-muted">
    {children}
  </p>
);

/* --------------------------------- forms --------------------------------- */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-display text-[11.5px] font-medium uppercase tracking-[0.1em] text-plum-soft">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[12px] leading-snug text-muted">{hint}</span> : null}
    </label>
  );
}

/** A labelled on/off switch — used heavily by the organization settings form. */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={[
        "flex cursor-pointer items-start gap-3 rounded-[14px] border-[1.5px] px-3.5 py-3 transition",
        checked ? "border-plum/35 bg-petal" : "border-ink/10 bg-white",
        disabled ? "cursor-not-allowed opacity-60" : "hover:border-plum/30",
      ].join(" ")}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-plum"
      />
      <span className="min-w-0">
        <span className="block font-display text-[14px] font-medium leading-snug text-ink">
          {label}
        </span>
        {hint ? <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/* --------------------------------- modal --------------------------------- */

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  // Escape closes it, which is what anybody working quickly will reach for.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/55 p-4 sm:items-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={[
          "my-auto w-full rounded-xl3 bg-cream p-5 shadow-lift sm:p-6",
          wide ? "max-w-[760px]" : "max-w-[520px]",
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="font-display text-[19px] font-medium leading-snug text-plum">{title}</h2>
          <button
            onClick={onClose}
            className="-mr-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[17px] text-muted hover:bg-ink/5 hover:text-plum"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------- formatting ------------------------------ */

export const secs = (ms: number) => {
  // A row that is missing the field renders an em dash rather than "NaNm NaNs".
  if (!Number.isFinite(ms)) return "—";
  const t = Math.max(0, ms) / 1000;
  if (t < 60) return `${t.toFixed(1)}s`;
  const m = Math.floor(t / 60);
  return `${m}m ${String(Math.round(t % 60)).padStart(2, "0")}s`;
};

export const when = (iso: string | null | undefined, withTime = true) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        year: "numeric",
        ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
      })
    : "—";

export const MEDALS = ["🥇", "🥈", "🥉"];
