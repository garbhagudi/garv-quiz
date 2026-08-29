import { sql } from "@/lib/db";
import { ok, fail, route, requireWriter, audit } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 2 MB. A question picture is a diagram or a micrograph on a phone screen, and
 * every byte is read out of Postgres on the way to the student, so this is
 * deliberately tight. The same ceiling is a CHECK on the table.
 */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * What the file actually is, read from its first bytes rather than from the
 * name or the Content-Type the browser claimed. A file that says .png but is
 * really an HTML document would otherwise be served back from our own origin.
 */
function sniff(b: Uint8Array): string | null {
  const at = (i: number, ...want: number[]) => want.every((w, k) => b[i + k] === w);
  const ascii = (i: number, s: string) =>
    [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

  if (b.length < 12) return null;
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/**
 * POST /api/admin/uploads   (multipart/form-data, field name "file")
 *
 * Stores one picture and hands back the path to read it at. Pictures live in
 * the database because the app runs on serverless functions with no writable
 * disk — see the `media` table in db/schema.sql.
 */
export const POST = route(async (req: Request) => {
  const admin = await requireWriter();

  const form = await req.formData().catch(() => null);
  if (!form) return fail("Send the picture as a file upload.", 400, "file");

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return fail("Choose a picture to upload.", 400, "file");

  if (file.size > MAX_BYTES)
    return fail(
      `That picture is ${(file.size / 1024 / 1024).toFixed(1)} MB. Please use one under 2 MB.`,
      413,
      "file",
    );

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Re-check after reading: `size` is what the browser announced, `length` is
  // what actually arrived.
  if (bytes.length === 0 || bytes.length > MAX_BYTES)
    return fail("That picture is too large. Please use one under 2 MB.", 413, "file");

  const mime = sniff(bytes);
  if (!mime) return fail("That file is not a PNG, JPEG, WebP or GIF picture.", 415, "file");

  const name = (file.name || "picture").slice(0, 120);

  // The Neon HTTP driver sends parameters as text, so the bytes travel as
  // base64 and Postgres turns them back into bytea.
  const [row] = (await sql`
    INSERT INTO media (mime, bytes, byte_size, original_name, uploaded_by)
    VALUES (${mime},
            decode(${Buffer.from(bytes).toString("base64")}, 'base64'),
            ${bytes.length}, ${name}, ${admin.aid})
    RETURNING id`) as unknown as { id: string }[];

  await audit(admin, "media.upload", name, { id: row.id, mime, bytes: bytes.length });

  return ok({ url: `/api/media/${row.id}`, mime, byteSize: bytes.length }, 201);
});
