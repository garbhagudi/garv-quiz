import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The white brand bar that tops every student-facing screen.
 *
 * The artwork stacks the GarbhaGudi lockup above the GARV wordmark (715 × 330),
 * so it is nearly twice as tall for its width as a single-line logo. The widths
 * below are set from the fine print rather than the wordmark: the Kannada type
 * and "The art of ART" stop being readable much under 240px.
 */
export function BrandBar() {
  // Stays true white in both themes: the black GARV wordmark only works on
  // white, and this plate is what kept it readable when a phone darkened
  // everything else around it.
  return (
    <header className="mb-3.5 flex items-center justify-center rounded-[20px] border border-brand/15 bg-white px-4 py-3.5 shadow-bar sm:px-5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/garv-2026-logo.webp"
        alt="GarbhaGudi · GARV 2026 — The art of ART"
        width={715}
        height={330}
        className="h-auto w-full max-w-[248px] sm:max-w-[288px]"
      />
    </header>
  );
}

/**
 * The student-facing shell: blush ground, brand bar, one cream card. Everything
 * a student ever sees lives inside this, at a phone-first 560px maximum.
 *
 * The eyebrow and the footer sit on the page rather than in the card, so they
 * are inked for a light ground — crimson for the eyebrow, the muted plum-grey
 * for the small print. Anything added out here needs the same treatment.
 */
export function Stage({
  children,
  eyebrow,
  footer,
}: {
  children: ReactNode;
  eyebrow?: string;
  footer?: ReactNode;
}) {
  return (
    <div className="surface-stage flex justify-center px-3.5 pb-9 pt-4.5">
      <div className="w-full max-w-[560px]">
        {eyebrow ? (
          <p className="eyebrow mb-2.5 mt-0.5 text-center text-brand-deep">{eyebrow}</p>
        ) : null}
        <BrandBar />
        <main className="card animate-rise">{children}</main>
        {footer ? <div className="mt-4">{footer}</div> : null}
        <p className="mt-5 text-center text-[12px] leading-relaxed text-muted">
          GarbhaGudi IVF Centre ·{" "}
          <Link href="/" className="underline underline-offset-2 hover:text-brand-deep">
            Enter a different code
          </Link>
        </p>
      </div>
    </div>
  );
}

/**
 * The progress dots from the original quiz: one per question, filled as you go,
 * with the current one pulsing. Doubles as a loading indicator.
 */
export function Dots({
  total,
  done,
  current,
}: {
  total: number;
  done?: number;
  current?: boolean;
}) {
  return (
    <div className="mb-4.5 flex flex-wrap gap-[5px]" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => {
        const isDone = done !== undefined && i < done;
        const isNow = current === undefined ? done !== undefined && i === done : current;
        return (
          <span
            key={i}
            className={[
              "h-[15px] w-[15px] rounded-full border-[1.5px] transition-all duration-200",
              isDone
                ? "border-plum bg-plum"
                : isNow
                  ? "animate-pulseDot border-apricot bg-apricot"
                  : "border-plum/25 bg-transparent",
            ].join(" ")}
          />
        );
      })}
    </div>
  );
}

/**
 * Progress through the quiz, as a bar.
 *
 * `Dots` came from the original 15-question quiz, where one circle per question
 * fitted on a single row and could be read at a glance. A 30-question set wraps
 * it onto two rows of thirty 15px circles on a phone - about 58px of vertical
 * space, above every question, that nobody can actually count. A bar carries
 * the same information at any length and in a fifth of the height.
 *
 * Hidden from screen readers: the "Question 12 of 30" beside it already says
 * this, and saying it twice helps nobody.
 */
export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
  return (
    <div
      /* Bracketed opacity: 12 is not on Tailwind's opacity scale, so `bg-plum/12`
         silently emits nothing and the track renders solid plum - a bar that
         looks full at question one. Same convention as border-ink/[0.07]. */
      className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-plum/[0.12]"
      aria-hidden="true"
    >
      <div
        className="h-full rounded-full bg-plum transition-[width] duration-300 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** The four pulsing dots used while something loads. */
export const Loading = ({ label }: { label: string }) => (
  <>
    <h2 className="mb-3 font-display text-[19px] font-medium text-plum">{label}</h2>
    <Dots total={4} current />
  </>
);

/** The gift/prize note, carried over from the original. */
export const PrizeNote = ({ text }: { text: string }) =>
  text ? (
    <div className="mb-1 flex items-center gap-3 rounded-2xl bg-gradient-to-br from-prize-from to-prize-to px-4 py-3.5">
      <span className="text-[21px]" aria-hidden="true">
        🎁
      </span>
      <span className="text-[14.5px] font-bold leading-snug text-prize-ink">{text}</span>
    </div>
  ) : null;
