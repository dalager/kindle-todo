/**
 * Selects and builds the active TodoProvider from the environment.
 * Today only Microsoft To Do is wired in; add more `if` branches here as new
 * providers are implemented — the rest of the app is unaffected.
 */
import type { TodoProvider } from "./types";
import { MicrosoftTodoProvider, tokenStoreFromKv } from "./microsoft/provider";

/** Env fields the providers need. Kept minimal so index.ts's Env can extend it. */
export interface ProviderEnv {
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  MS_REFRESH_TOKEN?: string;
  MS_DEFAULT_LIST_ID?: string;
  /** Optional KV namespace persisting Microsoft's rotating refresh token. */
  MS_TOKEN_STORE?: KVNamespace;
}

export function createProvider(env: ProviderEnv): TodoProvider {
  if (
    env.MS_CLIENT_ID &&
    env.MS_CLIENT_SECRET &&
    env.MS_REFRESH_TOKEN &&
    env.MS_DEFAULT_LIST_ID
  ) {
    return new MicrosoftTodoProvider({
      clientId: env.MS_CLIENT_ID,
      clientSecret: env.MS_CLIENT_SECRET,
      refreshToken: env.MS_REFRESH_TOKEN,
      listId: env.MS_DEFAULT_LIST_ID,
      tokenStore: tokenStoreFromKv(env.MS_TOKEN_STORE),
    });
  }

  throw new Error(
    "No todo provider configured. Set MS_CLIENT_ID, MS_CLIENT_SECRET, " +
      "MS_REFRESH_TOKEN and MS_DEFAULT_LIST_ID.",
  );
}
