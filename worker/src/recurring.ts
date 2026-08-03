/**
 * Daily recurring tasks.
 *
 * A task whose title contains `*` is a daily chore: ticking it off in Microsoft
 * To Do clears it from the wall for the rest of the day, and at local midnight
 * it is reopened so it's back up the next morning. Tasks without the marker stay
 * completed for good — the normal one-shot todo.
 *
 * The marker is *app* policy, not provider behavior. Providers expose only the
 * primitives (`completed()` / `reopen()`), so this module is the single place
 * that knows what `*` means and when the day rolls over.
 *
 * ## Why midnight is decided here and not by the cron
 *
 * Cron Triggers fire on UTC only, but "midnight" means midnight in the
 * household's timezone — which drifts an hour twice a year. Rather than edit the
 * schedule at every DST switch, the Worker registers *both* candidate UTC hours
 * (see `triggers.crons` in wrangler.jsonc) and {@link isLocalMidnight} decides
 * which of the two is actually midnight today. The other one is an hour off and
 * returns without touching anything.
 */
import type { TodoProvider } from "./providers/types";

/** A title containing this marker is a daily recurring task. */
export const RECURRING_MARKER = "*";

/** IANA zone the reset's "midnight" is measured in. Override with RESET_TIMEZONE. */
export const DEFAULT_TIMEZONE = "Europe/Copenhagen";

/**
 * Is this a daily recurring task? The marker may sit anywhere in the title
 * ("* Opvask", "Opvask *"), since it's typed by hand on a phone.
 */
export function isRecurring(text: string): boolean {
  return text.includes(RECURRING_MARKER);
}

/**
 * The hour (0-23) that `epochMs` falls in, in `timeZone`.
 * `hourCycle: "h23"` matters: with `hour12: false` some ICU builds render
 * midnight as "24", which would never equal 0.
 */
export function localHour(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const hour = parts.find((p) => p.type === "hour");
  return hour ? Number(hour.value) % 24 : NaN;
}

/** True when `epochMs` lands in the midnight hour of `timeZone`. */
export function isLocalMidnight(epochMs: number, timeZone: string): boolean {
  return localHour(epochMs, timeZone) === 0;
}

/** What one nightly reset did — logged, and returned by the manual trigger. */
export interface ResetResult {
  /** Completed tasks looked at. */
  scanned: number;
  /** Titles of the tasks put back on the list. */
  reopened: string[];
  /** Matched but could not be reopened; the rest of the run still went ahead. */
  failed: { text: string; error: string }[];
}

/**
 * Reopen every completed `*` task in `listId`.
 *
 * Failures are per-task: one task Graph refuses (deleted mid-run, a 429) must
 * not strand the other chores as done. Anything left failed is simply picked up
 * by tomorrow's run.
 */
export async function resetRecurring(
  provider: TodoProvider,
  listId: string,
): Promise<ResetResult> {
  const completed = await provider.completed(listId);
  const due = completed.filter((todo) => isRecurring(todo.text));

  const result: ResetResult = { scanned: completed.length, reopened: [], failed: [] };
  for (const todo of due) {
    try {
      await provider.reopen(todo.id, listId);
      result.reopened.push(todo.text);
    } catch (err) {
      result.failed.push({
        text: todo.text,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
  return result;
}
