export type Role = "owner" | "admin" | "viewer";

export type AdminUser = {
  id: number;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
};

export type QuestionSet = {
  id: number;
  name: string;
  description: string;
  is_archived: boolean;
  created_at: string;
  question_count?: number;
  organization_count?: number;
};

export type Question = {
  id: number;
  set_id: number;
  position: number;
  text: string;
  options: string[];
  /** The first correct option. Kept in step with `correct_indexes[0]`. */
  correct_index: number;
  /** Every correct option, 0-based, ascending. One entry means one right answer. */
  correct_indexes: number[];
  /** `/api/media/<uuid>` for an uploaded picture, an https:// link, or "". */
  image_url: string;
  image_alt: string;
  explanation: string;
  points: number;
  is_active: boolean;
};

/** A question as it is safe to hand to a student's phone: no answer key. */
export type PublicQuestion = {
  id: number;
  position: number;
  text: string;
  options: string[];
  points: number;
  /** True when more than one option is correct, so the phone asks for a set. */
  multi: boolean;
  imageUrl: string;
  imageAlt: string;
};

export type Organization = {
  id: number;
  slug: string;
  name: string;
  city: string;
  contact_name: string;
  contact_phone: string;
  event_date: string | null;
  notes: string;
  question_set_id: number | null;
  is_open: boolean;
  /** Deadline the current round was started with; null when it has no end. */
  closes_at: string | null;
  question_count: number | null;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  allow_retake: boolean;
  show_score: boolean;
  show_leaderboard: boolean;
  require_email: boolean;
  collect_class: boolean;
  prize_note: string;
  created_at: string;
};

/** What the public organization page needs — deliberately a subset of Organization. */
export type OrganizationPublic = Pick<
  Organization,
  | "slug"
  | "name"
  | "city"
  | "is_open"
  | "closes_at"
  | "show_leaderboard"
  | "require_email"
  | "collect_class"
  | "prize_note"
  | "allow_retake"
> & { total_questions: number; participants: number };

export type LeaderboardRow = {
  rank: number;
  name: string;
  score: number;
  max_score: number;
};

/** The admin view of a result row — everything, including contact details. */
export type ResultRow = LeaderboardRow & {
  attempt_id: number;
  public_id: string;
  participant_id: number;
  phone: string;
  email: string;
  class_or_year: string;
  correct_count: number;
  question_count: number;
  accuracy: number;
  answer_ms: number;
  elapsed_ms: number;
  submitted_at: string;
  attempt_no: number;
};

export type ApiError = { ok: false; error: string; field?: string };
export type ApiOk<T> = { ok: true } & T;
