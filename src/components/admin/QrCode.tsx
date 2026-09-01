"use client";

import qrcode from "qrcode-generator";

/**
 * The join link as a QR code.
 *
 * Drawn as inline SVG for the screen, because the point of this on the day is
 * that it goes on a projector and forty phones read it from across a room. The
 * same module grid is redrawn onto a canvas for the download, so the file and
 * the screen can never disagree about what they encode.
 *
 * Deliberately near-black on white. A QR in the brand crimson looks nicer and
 * scans worse, and a code that needs three attempts in a lecture hall is not
 * worth the styling.
 */

/** Modules of clear space the spec requires around a code for readers to lock on. */
const QUIET = 4;
const INK = "#241539";

/** True only once the caller has a real link — see the note in QrCode. */
export const isAbsolute = (value: string) => /^https?:\/\//i.test(value);

/** One source of truth for the module grid, shared by the SVG and the PNG. */
function matrix(value: string) {
  const qr = qrcode(0, "M"); // smallest version that fits, medium error correction
  qr.addData(value);
  qr.make();
  const count = qr.getModuleCount();
  return { count, side: count + QUIET * 2, isDark: (r: number, c: number) => qr.isDark(r, c) };
}

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
  if (!isAbsolute(value)) {
    return (
      <div
        className={`rounded-[10px] border border-dashed border-ink/15 bg-white ${className ?? ""}`}
        aria-hidden="true"
      />
    );
  }

  const { count, side, isDark } = matrix(value);

  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (isDark(row, col)) d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`;
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
      <path d={d} fill={INK} />
    </svg>
  );
}

/**
 * Save the code as a PNG, with the address printed underneath.
 *
 * The link belongs in the file: a bare QR on a noticeboard is useless to anyone
 * whose camera will not read it, and it gives whoever prints it no way to check
 * they have the right event. Drawn straight onto a canvas from the module grid
 * rather than by rasterising the SVG, which keeps it free of any font or image
 * loading that could taint the canvas or land half-finished.
 */
export function downloadQrPng(value: string, fileName: string, caption = value) {
  if (!isAbsolute(value) || typeof document === "undefined") return;

  const { count, side, isDark } = matrix(value);

  const scale = 24; // module size in pixels — a 29-module code lands near 900px
  const qrPx = side * scale;
  const pad = scale * 2;
  const captionPx = Math.round(scale * 1.6);
  const height = qrPx + pad + captionPx + pad;

  const canvas = document.createElement("canvas");
  canvas.width = qrPx;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = INK;
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (isDark(row, col)) {
        ctx.fillRect((col + QUIET) * scale, (row + QUIET) * scale, scale, scale);
      }
    }
  }

  ctx.font = `600 ${captionPx}px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(caption, qrPx / 2, qrPx + pad + captionPx / 2, qrPx - pad);

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Freed on the next tick: revoking synchronously can cancel the download.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, "image/png");
}
