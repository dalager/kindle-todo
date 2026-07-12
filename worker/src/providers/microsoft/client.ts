/**
 * Minimal Microsoft To Do client for Cloudflare Workers (and any fetch runtime).
 *
 * Ported from `todocli/graphapi/wrapper.py`, exposing just the surface needed
 * to read and complete tasks:
 *   - listLists()            -> get_lists()
 *   - listTasks(listId, ...) -> get_tasks(list_id=...)
 *   - completeTask(...)      -> complete_task(list_id=..., task_id=...)
 *
 * Zero dependencies: uses the global `fetch`.
 */

import { TokenManager, type TokenManagerConfig } from "./auth";
import type {
  GraphCollection,
  GraphDateTimeTimeZone,
  ListTasksOptions,
  RawTask,
  RawTodoList,
  Task,
  TodoList,
} from "./graph-types";

const BASE_API = "https://graph.microsoft.com/v1.0";
const BASE_URL = `${BASE_API}/me/todo/lists`;

/** Thrown when a Graph request returns a non-OK status. */
export class GraphApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

export type MicrosoftTodoClientConfig = TokenManagerConfig;

export class MicrosoftTodoClient {
  private readonly tokens: TokenManager;

  constructor(config: MicrosoftTodoClientConfig | TokenManager) {
    this.tokens = config instanceof TokenManager ? config : new TokenManager(config);
  }

  /** List all To Do lists. Port of `get_lists()`. */
  async listLists(): Promise<TodoList[]> {
    const data = await this.request<GraphCollection<RawTodoList>>("GET", BASE_URL);
    return data.value.map(mapList);
  }

  /**
   * List tasks in a list by list id. Port of `get_tasks(list_id=...)`.
   *
   * By default only open (not completed) tasks are returned, matching the CLI.
   */
  async listTasks(listId: string, options: ListTasksOptions = {}): Promise<Task[]> {
    const { numTasks = 100, includeCompleted = false, onlyCompleted = false } = options;

    // Build the query manually so spaces in `$filter` are encoded as `%20`
    // (matching the Python client) rather than `+` as URLSearchParams would do.
    const query = [`$top=${encodeURIComponent(numTasks)}`];
    if (onlyCompleted) {
      query.push(`$filter=${encodeURIComponent("status eq 'completed'")}`);
    } else if (!includeCompleted) {
      query.push(`$filter=${encodeURIComponent("status ne 'completed'")}`);
    }

    const url = `${BASE_URL}/${encodeURIComponent(listId)}/tasks?${query.join("&")}`;
    const data = await this.request<GraphCollection<RawTask>>("GET", url);
    return data.value.map(mapTask);
  }

  /**
   * Mark a task as completed. Port of `complete_task(list_id=..., task_id=...)`.
   * Returns the updated task.
   */
  async completeTask(listId: string, taskId: string): Promise<Task> {
    const url = `${BASE_URL}/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;
    const body = {
      status: "completed",
      completedDateTime: toApiTimestamp(new Date()),
    };
    const data = await this.request<RawTask>("PATCH", url, body);
    return mapTask(data);
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const accessToken = await this.tokens.getAccessToken();
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new GraphApiError(
        `Graph request failed: ${method} ${url} (${response.status})`,
        response.status,
        text,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

// --- Mapping helpers (mirror the Python model constructors) ---

function mapList(raw: RawTodoList): TodoList {
  return {
    id: raw.id,
    displayName: raw.displayName,
    isOwner: Boolean(raw.isOwner),
    isShared: Boolean(raw.isShared),
    wellKnownListName: raw.wellknownListName,
  };
}

function mapTask(raw: RawTask): Task {
  const note = raw.body?.content ? raw.body.content : null;
  return {
    id: raw.id,
    title: raw.title,
    status: raw.status,
    importance: raw.importance,
    isReminderOn: Boolean(raw.isReminderOn),
    note,
    createdDateTime: normalizeTimestamp(raw.createdDateTime),
    lastModifiedDateTime: normalizeTimestamp(raw.lastModifiedDateTime),
    dueDateTime: normalizeTimestamp(raw.dueDateTime),
    reminderDateTime: normalizeTimestamp(raw.reminderDateTime),
    completedDateTime: normalizeTimestamp(raw.completedDateTime),
  };
}

/**
 * Normalize a Graph timestamp to an ISO-8601 UTC string.
 * Graph returns either a plain string (createdDateTime, ...) or a
 * `dateTimeTimeZone` object (dueDateTime, ...). Mirrors
 * `api_timestamp_to_datetime` but keeps UTC rather than converting to local.
 */
function normalizeTimestamp(
  value: GraphDateTimeTimeZone | string | undefined | null,
): string | null {
  if (value == null) return null;
  const raw = typeof value === "string" ? value : value.dateTime;
  if (!raw) return null;
  const parsed = new Date(raw.endsWith("Z") ? raw : `${raw}Z`);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

/** Build a Graph `dateTimeTimeZone` value. Mirrors `datetime_to_api_timestamp`. */
function toApiTimestamp(date: Date): GraphDateTimeTimeZone {
  return {
    dateTime: date.toISOString().replace(/\.\d{3}Z$/, ""),
    timeZone: "UTC",
  };
}
