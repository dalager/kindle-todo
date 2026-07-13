/**
 * Microsoft To Do implementation of TodoProvider.
 *
 * Adapts the ported Graph client (client.ts / auth.ts) to the app's normalized
 * Todo shape and pins it to a single configured list (MS_DEFAULT_LIST_ID).
 */
import { MicrosoftTodoClient } from "./client";
import { kvTokenStore, type TokenStore } from "./auth";
import type { Todo, TodoListInfo, TodoProvider } from "../types";

export interface MicrosoftProviderConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The To Do list to display / complete tasks in (Graph list id). */
  listId: string;
  /** Optional KV to persist Microsoft's rotating refresh token. */
  tokenStore?: TokenStore;
}

export class MicrosoftTodoProvider implements TodoProvider {
  private readonly client: MicrosoftTodoClient;
  readonly defaultListId: string;
  /** List names are stable; resolve each once per isolate, keyed by list id. */
  private readonly titleCache = new Map<string, string>();

  constructor(config: MicrosoftProviderConfig) {
    this.client = new MicrosoftTodoClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
      tokenStore: config.tokenStore,
    });
    this.defaultListId = config.listId;
  }

  async lists(): Promise<TodoListInfo[]> {
    const lists = await this.client.listLists();
    return lists.map((l) => ({ id: l.id, name: l.displayName }));
  }

  async title(listId: string = this.defaultListId): Promise<string> {
    const cached = this.titleCache.get(listId);
    if (cached !== undefined) return cached;
    const name = await this.client.getListName(listId);
    this.titleCache.set(listId, name);
    return name;
  }

  /** Open tasks in the given list, newest-relevant order from Graph. */
  async list(listId: string = this.defaultListId): Promise<Todo[]> {
    const tasks = await this.client.listTasks(listId); // open tasks only
    return tasks.map((t) => ({
      id: t.id,
      text: t.title,
      done: t.status === "completed",
    }));
  }
}

/** Convenience: build a KV-backed token store from a KV namespace, if present. */
export function tokenStoreFromKv(
  kv: { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> } | undefined,
): TokenStore | undefined {
  return kv ? kvTokenStore(kv) : undefined;
}
