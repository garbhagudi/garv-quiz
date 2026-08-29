import { z } from "zod";
import { normalizeQuestionText } from "./questionText";

/** Indian 10-digit mobile numbers, tolerant of +91 / 0 / spaces / dashes on input. */
export function normalizePhone(raw: unknown): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export const phoneField = z
  .string()
  .transform(normalizePhone)
  .refine((v) => /^[6-9]\d{9}$/.test(v), "Enter a valid 10-digit mobile number.");

export const nameField = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .refine((s) => s.length >= 3, "Enter your full name (at least 3 letters).")
  .refine((s) => s.length <= 80, "That name is too long.");

export const emailField = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s), "Enter a valid email address.")
  .refine((s) => s.length <= 120, "That email address is too long.");

/**
 * Turns "St. Xavier's College — Bengaluru 2026" into "st-xaviers-college-bengaluru-2026".
 * Kept short and URL-safe because students type it by hand.
 */
export function slugify(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const slugField = z
  .string()
  .transform((s) => slugify(s))
  .refine((s) => s.length >= 3, "The code needs at least 3 characters.")
  .refine((s) => !RESERVED_SLUGS.has(s), "That code is reserved. Pick another.");

/** Paths the app itself owns, so an organization can never shadow a real route. */
export const RESERVED_SLUGS = new Set([
  "admin", "api", "s", "login", "logout", "dashboard", "quiz", "result",
  "results", "leaderboard", "static", "public", "assets", "_next", "favicon",
  "new", "edit", "settings", "help", "about",
  "organization", "organizations", "org", "orgs", "school", "schools",
]);

/** The most options one question can offer, and so the longest answer key. */
export const MAX_OPTIONS = 8;

/* ---------------------------- request bodies ---------------------------- */

export const registerSchema = z.object({
  slug: z.string().min(1),
  name: nameField,
  phone: phoneField,
  email: z.string().optional().default(""),
  classOrYear: z.string().max(60).optional().default(""),
});

export const submitSchema = z.object({
  attemptId: z.string().min(1),
  elapsedMs: z.number().int().nonnegative().max(6 * 60 * 60 * 1000).optional().default(0),
  answers: z
    .array(
      z.object({
        position: z.number().int().nonnegative().max(500),
        // `optionIndexes` is what the app sends: one tap for an ordinary
        // question, several for a "select all that apply" one. `optionIndex` is
        // the older single-answer form, still accepted so a page left open
        // across a deploy can still submit. Either way the marking happens on
        // the server against the stored snapshot.
        optionIndex: z.number().int().min(-1).max(50).optional(),
        optionIndexes: z.array(z.number().int().min(0).max(50)).max(MAX_OPTIONS).optional(),
        ms: z.number().int().nonnegative().max(60 * 60 * 1000).optional().default(0),
      }),
    )
    .max(500),
});

export const adminLoginSchema = z.object({
  email: z.string().min(3).max(160),
  password: z.string().min(1).max(200),
});

export const participantLoginSchema = z.object({
  slug: z.string().min(1),
  name: z.string().max(80).optional().default(""),
  phone: phoneField,
});

const optionsField = z
  .array(z.string().transform((s) => s.trim()))
  .min(2, "A question needs at least 2 options.")
  .max(MAX_OPTIONS, `A question can have at most ${MAX_OPTIONS} options.`)
  .refine((a) => a.every((s) => s.length > 0), "Options cannot be blank.")
  .refine(
    (a) => new Set(a.map((s) => s.toLowerCase())).size === a.length,
    "Two options are identical.",
  );

/**
 * A question's picture: either one uploaded through the admin panel, which
 * lands at /api/media/<uuid>, or a full https:// link to an image hosted
 * elsewhere. Blank means the question has no picture. http:// is refused so a
 * picture can never make the page insecure.
 */
export const imageUrlField = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length <= 500, "That image link is too long.")
  .refine(
    (s) =>
      s === "" ||
      /^\/api\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
      /^https:\/\/[^\s"'<>]+$/.test(s),
    "Upload a picture, or paste a full https:// link to one.",
  );

/**
 * Normalises the answer key a request sent, from either field, into the shape
 * the database stores: ascending, no repeats.
 *
 * `correctIndexes` is what the admin panel sends. `correctIndex` is the older
 * single-answer field, still honoured so an integration written against the
 * previous API keeps working.
 */
export function answerKeyOf(v: {
  correctIndex?: number | null;
  correctIndexes?: number[] | null;
}): number[] {
  const raw = v.correctIndexes?.length
    ? v.correctIndexes
    : typeof v.correctIndex === "number"
      ? [v.correctIndex]
      : [];
  return [...new Set(raw)].sort((a, b) => a - b);
}

export const questionSchema = z
  .object({
    setId: z.coerce.number().int().positive(),
    // Question wording may run to several lines, so it is tidied rather than
    // simply trimmed: a line opening with "-" or "1." becomes a list item when
    // it is drawn. See src/lib/questionText.ts.
    text: z
      .string()
      .transform(normalizeQuestionText)
      .refine((s) => s.length >= 5, "Write the question.")
      .refine((s) => s.length <= 2000, "That question is too long — keep it under 2000 characters.")
      .refine(
        (s) => s.split("\n").length <= 40,
        "That is a lot of lines for one question — keep it under 40.",
      ),
    options: optionsField,
    correctIndex: z.coerce.number().int().min(0).max(MAX_OPTIONS * 10).optional(),
    correctIndexes: z
      .array(z.coerce.number().int().min(0).max(MAX_OPTIONS * 10))
      .max(MAX_OPTIONS)
      .optional(),
    imageUrl: imageUrlField.optional().default(""),
    imageAlt: z.string().transform((s) => s.trim().slice(0, 200)).optional().default(""),
    explanation: z.string().max(1000).optional().default(""),
    points: z.coerce.number().int().min(1).max(100).optional().default(1),
    position: z.coerce.number().int().min(0).optional(),
    isActive: z.boolean().optional().default(true),
  })
  .refine((v) => answerKeyOf(v).length > 0, {
    message: "Tick the option — or options — that are correct.",
    path: ["correctIndexes"],
  })
  .refine((v) => answerKeyOf(v).every((i) => i < v.options.length), {
    message: "Mark which option is correct.",
    path: ["correctIndexes"],
  })
  .refine((v) => answerKeyOf(v).length < v.options.length, {
    message: "Every option cannot be correct — there would be nothing to work out.",
    path: ["correctIndexes"],
  });

export const organizationSchema = z.object({
  name: z.string().transform((s) => s.trim()).refine((s) => s.length >= 3, "Enter the organization name."),
  slug: slugField,
  city: z.string().max(80).optional().default(""),
  contactName: z.string().max(80).optional().default(""),
  contactPhone: z.string().max(20).optional().default(""),
  eventDate: z.string().optional().nullable().default(null),
  notes: z.string().max(2000).optional().default(""),
  questionSetId: z.coerce.number().int().positive().nullable().optional().default(null),
  isOpen: z.boolean().optional().default(true),
  questionCount: z.coerce.number().int().positive().nullable().optional().default(null),
  shuffleQuestions: z.boolean().optional().default(false),
  shuffleOptions: z.boolean().optional().default(true),
  allowRetake: z.boolean().optional().default(false),
  showScore: z.boolean().optional().default(true),
  showLeaderboard: z.boolean().optional().default(true),
  requireEmail: z.boolean().optional().default(true),
  collectClass: z.boolean().optional().default(false),
  prizeNote: z.string().max(400).optional().default(""),
});

/**
 * Update form of the above. Every field is optional with no default, so a
 * caller that sends only `{ isOpen: false }` changes only that — the route
 * merges the rest from the stored row rather than resetting it.
 */
export const organizationPatchSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= 3, "Enter the organization name.")
    .optional(),
  slug: slugField.optional(),
  city: z.string().max(80).optional(),
  contactName: z.string().max(80).optional(),
  contactPhone: z.string().max(20).optional(),
  eventDate: z.string().nullable().optional(),
  notes: z.string().max(2000).optional(),
  questionSetId: z.coerce.number().int().positive().nullable().optional(),
  isOpen: z.boolean().optional(),
  questionCount: z.coerce.number().int().positive().nullable().optional(),
  shuffleQuestions: z.boolean().optional(),
  shuffleOptions: z.boolean().optional(),
  allowRetake: z.boolean().optional(),
  showScore: z.boolean().optional(),
  showLeaderboard: z.boolean().optional(),
  requireEmail: z.boolean().optional(),
  collectClass: z.boolean().optional(),
  prizeNote: z.string().max(400).optional(),
});

/**
 * A whole-quiz time limit, in minutes as the admin panel asks for it. Blank or
 * 0 means no limit, which is what every set has until somebody sets one.
 * The floor of one minute and the ceiling of six hours match the CHECK on the
 * column.
 */
export const timeLimitMinutesField = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => {
    // Only an absent or empty value means "no limit". Anything else has to be a
    // usable number: a typo must be refused, not quietly turned into no limit
    // on a set somebody had deliberately timed.
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  })
  .refine(
    (n) => n === null || (Number.isInteger(n) && n >= 1 && n <= 360),
    "Set a whole number of minutes between 1 and 360, or leave it blank for no limit.",
  );

export const adminUserSchema = z.object({
  email: emailField,
  name: nameField,
  role: z.enum(["owner", "admin", "viewer"]),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
});

/** Turns a ZodError into the single, human-readable message the UI shows. */
export function firstError(e: z.ZodError): { error: string; field?: string } {
  const issue = e.issues[0];
  return { error: issue?.message ?? "Please check the form.", field: issue?.path.join(".") };
}
