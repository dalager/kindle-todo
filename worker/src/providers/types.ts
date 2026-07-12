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

export interface TodoProvider {
  /** Display title of the list (e.g. the To Do list name). Used as the header. */
  title(): Promise<string>;
  /** The tasks to display (open/pending tasks). */
  list(): Promise<Todo[]>;
  /** Mark a task complete by its id. */
  complete(id: string): Promise<void>;
}
