/**
 * OAuth2 token handling for non-interactive (server / Worker) use.
 *
 * The Python CLI (`todocli/graphapi/oauth.py`) performs an interactive
 * authorization-code flow the first time, then stores and refreshes a token.
 * A Worker cannot run an interactive flow, so this module uses the
 * **refresh-token grant**: given a pre-obtained refresh token plus the app's
 * client id/secret, it exchanges them for short-lived access tokens.
 *
 * Microsoft rotates refresh tokens on every use. When a {@link TokenStore} is
 * supplied the rotated token is persisted so it survives across requests;
 * otherwise the client falls back to the bootstrap refresh token from config
 * on each cold start (which keeps working within the token's validity window).
 */

/** Default scope — matches `settings["scopes"]` in the Python client. */
export const DEFAULT_SCOPE =
  "openid offline_access https://graph.microsoft.com/Tasks.ReadWrite";

/** Default authority — matches the Python client. */
export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/common";

/** A persisted token as returned by the token endpoint (fields we use). */
export interface StoredToken {
  access_token: string;
  refresh_token: string;
  /** Absolute expiry as a Unix timestamp in seconds. */
  expires_at: number;
}

/**
 * Pluggable persistence for the rotating refresh token. A Cloudflare KV
 * namespace satisfies this interface directly:
 *   `new TokenManager({ ..., tokenStore: kvTokenStore(env.TODO_TOKENS) })`
 */
export interface TokenStore {
  get(): Promise<StoredToken | null>;
  set(token: StoredToken): Promise<void>;
}

export interface TokenManagerConfig {
  clientId: string;
  clientSecret: string;
  /** Bootstrap refresh token, used when the store is empty. */
  refreshToken: string;
  tokenStore?: TokenStore;
  authority?: string;
  scope?: string;
}

/** Raw token-endpoint response. */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/** Thrown when the token endpoint rejects the refresh request. */
export class TokenRefreshError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

/** Refresh 5 minutes early to account for clock skew (matches Python). */
const CLOCK_SKEW_SECONDS = 300;

export class TokenManager {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly bootstrapRefreshToken: string;
  private readonly tokenStore?: TokenStore;
  private readonly tokenUrl: string;
  private readonly scope: string;

  /** In-memory cache for the life of the isolate, avoids re-refreshing. */
  private cached: StoredToken | null = null;

  constructor(config: TokenManagerConfig) {
    if (!config.clientId || !config.clientSecret || !config.refreshToken) {
      throw new Error(
        "clientId, clientSecret, and refreshToken are all required",
      );
    }
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.bootstrapRefreshToken = config.refreshToken;
    this.tokenStore = config.tokenStore;
    this.scope = config.scope ?? DEFAULT_SCOPE;
    const authority = config.authority ?? DEFAULT_AUTHORITY;
    this.tokenUrl = `${authority}/oauth2/v2.0/token`;
  }

  /** Return a valid access token, refreshing if necessary. */
  async getAccessToken(): Promise<string> {
    const token = await this.loadToken();

    if (token && !this.isExpired(token)) {
      this.cached = token;
      return token.access_token;
    }

    const refreshToken = token?.refresh_token ?? this.bootstrapRefreshToken;
    const refreshed = await this.refresh(refreshToken);
    this.cached = refreshed;
    await this.tokenStore?.set(refreshed);
    return refreshed.access_token;
  }

  private async loadToken(): Promise<StoredToken | null> {
    if (this.cached) return this.cached;
    if (this.tokenStore) return this.tokenStore.get();
    return null;
  }

  private isExpired(token: StoredToken): boolean {
    const now = Math.floor(Date.now() / 1000);
    return now >= token.expires_at - CLOCK_SKEW_SECONDS;
  }

  private async refresh(refreshToken: string): Promise<StoredToken> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: this.scope,
    });

    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new TokenRefreshError(
        `Token refresh failed (${response.status})`,
        response.status,
        text,
      );
    }

    const data = JSON.parse(text) as TokenResponse;
    return {
      access_token: data.access_token,
      // Graph rotates the refresh token; fall back to the one we sent if absent.
      refresh_token: data.refresh_token ?? refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
    };
  }
}

/** Adapt a Cloudflare KV namespace to the {@link TokenStore} interface. */
export function kvTokenStore(
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> },
  key = "ms-todo-token",
): TokenStore {
  return {
    async get() {
      const raw = await kv.get(key);
      return raw ? (JSON.parse(raw) as StoredToken) : null;
    },
    async set(token) {
      await kv.put(key, JSON.stringify(token));
    },
  };
}
