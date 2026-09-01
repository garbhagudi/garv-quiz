"use client";

import qrcode from "qrcode-generator";

/**
 * The join link as a QR code, drawn as inline SVG.
 *
 * SVG rather than a canvas or an image so it stays sharp at any size — the
 * point of this on the day is that it goes on a projector and forty phones read
 * it from across a room. Every dark module is folded into one <path>, so a
 * 29x29 code is one DOM node instead of five hundred rectangles.
 *
 * Deliberately near-black on white. A QR in the brand crimson looks nicer and
 * scans worse, and a code that needs three attempts in a lecture hall is not
 * worth the styling.
 */

/** Modules of clear space the spec requires around a code for readers to lock on. */
const QUIET = 4;

export function QrCode({
  value,
  className,
  title,
}: {
  value: string;
  className?: string;
  title?: string;
}) {
  /* These screens are client components, so the first server render has no
     window and `value` is still a relative path. Encoding that would produce a
     code pointing at nothing, so draw a placeholder until it is a real link. */
  if (!/^https?:\/\//i.test(value)) {
    return (
      <div
        className={`rounded-[10px] border border-dashed border-ink/15 bg-white ${className ?? ""}`}
        aria-hidden="true"
      />
    );
  }

  const qr = qrcode(0, "M"); // smallest version that fits, medium error correction
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  const side = count + QUIET * 2;

  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`;
    }
  }

  return (
    <svg
      viewBox={`0 0 ${side} ${side}`}
      className={className}
      role="img"
      aria-label={title ?? `QR code for ${value}`}
      shapeRendering="crispEdges"
    >
      <rect width={side} height={side} fill="#ffffff" />
      <path d={d} fill="#241539" />
    </svg>
  );
}
