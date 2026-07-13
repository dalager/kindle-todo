/**
 * Provider abstraction: the rest of the app depends only on this interface,
 * not on any specific backend (Microsoft To Do, D1, etc.). Add a new backend
 * by implementing TodoProvider and wiring it into ./factory.
 */

/** The app's normalized todo item — what the page and PNG render. */
export interface Todo {
  /** Opaque id, unique within the provider (e.g. a Microsoft Graph task id). */
  id: string;
  text: string;
  done: boolean;
}

/** A selectable list, for the web page's list picker. */
export interface TodoListInfo {
  /** Opaque list id, unique within the provider. */
  id: string;
  /** Display name shown in the picker. */
  name: string;
}

export interface TodoProvider {
  /** The provider's configured default list id (preselected in the picker). */
  readonly defaultListId: string;
  /** All available lists, for the picker. */
  lists(): Promise<TodoListInfo[]>;
  /** Display title of a list (defaults to the configured list). Used as the header. */
  title(listId?: string): Promise<string>;
  /** The tasks to display (open/pending tasks) for a list (defaults to configured). */
  list(listId?: string): Promise<Todo[]>;
}
