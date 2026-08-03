/**
 * Type definitions mirroring the subset of the Microsoft Graph To Do API
 * used by this client. Ported from the Python models in
 * `todocli/models/` (TodoList, Task).
 */

/** Well-known list identifiers returned by Graph. */
export type WellKnownListName = "none" | "defaultList" | "flaggedEmails";

/** A To Do list. Mirrors `todocli.models.todolist.TodoList`. */
export interface TodoList {
  id: string;
  displayName: string;
  isOwner: boolean;
  isShared: boolean;
  wellKnownListName: WellKnownListName;
}

/** Task lifecycle status. Mirrors `todocli.models.todotask.TaskStatus`. */
export type TaskStatus =
  | "notStarted"
  | "inProgress"
  | "completed"
  | "waitingOnOthers"
  | "deferred";

/** Task importance. Mirrors `todocli.models.todotask.TaskImportance`. */
export type TaskImportance = "low" | "normal" | "high";

/**
 * A task within a list. Mirrors `todocli.models.todotask.Task`.
 * Date fields are normalized to ISO 8601 strings (UTC) or `null`.
 */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  importance: TaskImportance;
  isReminderOn: boolean;
  note: string | null;
  createdDateTime: string | null;
  lastModifiedDateTime: string | null;
  dueDateTime: string | null;
  reminderDateTime: string | null;
  completedDateTime: string | null;
}

/** Options for {@link MicrosoftTodoClient.listTasks}. */
export interface ListTasksOptions {
  /** Page size (Graph `$top`). Default 100. */
  numTasks?: number;
  /** Include completed tasks alongside open ones. Default false. */
  includeCompleted?: boolean;
  /** Return only completed tasks. Overrides `includeCompleted`. Default false. */
  onlyCompleted?: boolean;
  /**
   * How many pages to follow via `@odata.nextLink`. Default 1 — a single
   * request, matching the CLI. Raise it when the tail matters: a list's
   * *completed* tasks accumulate forever, so one page of 100 stops being the
   * whole picture after a few months of daily chores.
   */
  maxPages?: number;
}

// --- Raw Graph API shapes (internal) ---

/** Graph `dateTimeTimeZone` complex type. */
export interface GraphDateTimeTimeZone {
  dateTime: string;
  timeZone: string;
}

/** Raw list object as returned by Graph. */
export interface RawTodoList {
  id: string;
  displayName: string;
  isOwner: boolean;
  isShared: boolean;
  wellknownListName: WellKnownListName;
}

/** Raw task object as returned by Graph. */
export interface RawTask {
  id: string;
  title: string;
  status: TaskStatus;
  importance: TaskImportance;
  isReminderOn: boolean;
  body?: { content?: string; contentType?: string };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  dueDateTime?: GraphDateTimeTimeZone | string;
  reminderDateTime?: GraphDateTimeTimeZone | string;
  completedDateTime?: GraphDateTimeTimeZone | string;
}

/** Graph collection response envelope. */
export interface GraphCollection<T> {
  value: T[];
  /** Absolute URL of the next page, present only when the result is truncated. */
  "@odata.nextLink"?: string;
}
