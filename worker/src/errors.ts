/**
 * Friendly full-screen error states, shared by the Worker (which renders them
 * live when the backend fails) and the Kindle (which pre-downloads the
 * "unreachable" ones and draws them locally when it can't reach the Worker).
 *
 * The split matters: a screen can only be *rendered* while the Worker is up.
 * When the Worker is unreachable the device has no renderer, so those screens
 * (`nowifi`, `notfound`, `unauthorized`, `server`) are fetched once at deploy
 * time via GET /error/<kind>.png and drawn from disk.
 */

/** Screens the Worker renders live when a backend call fails. */
export type WorkerErrorKind = "backend" | "auth" | "credentials" | "list";
/** Screens the Kindle draws locally when the Worker itself is unreachable
 * (or, for `battery`, when the device itself needs attention). */
export type DeviceErrorKind = "nowifi" | "notfound" | "unauthorized" | "server" | "battery";
export type ErrorKind = WorkerErrorKind | DeviceErrorKind;

export interface ErrorScreen {
  emoji: string;
  title: string;
  body: string;
}

const REPO = "github.com/dalager/kindle-todo";

export const ERROR_SCREENS: Record<ErrorKind, ErrorScreen> = {
  // --- Worker-side: rendered live when Microsoft Graph fails ---
  backend: {
    emoji: "😵",
    title: "Microsoft To Do isn't responding",
    body: "Retrying automatically — the list comes back on its own.",
  },
  auth: {
    emoji: "🔑",
    title: "Microsoft sign-in expired",
    body: `Reconnect the account. See ${REPO}`,
  },
  credentials: {
    emoji: "🪪",
    title: "App credentials expired",
    body: `Rotate MS_CLIENT_SECRET in Azure, then wrangler secret put. See ${REPO}`,
  },
  list: {
    emoji: "🤔",
    title: "That list is gone",
    body: "Pick another list in the web app.",
  },

  // --- Device-side: drawn by the Kindle when the Worker is unreachable ---
  nowifi: {
    emoji: "😢",
    title: "No Wi-Fi",
    body: `Can't reach the internet — check Wi-Fi (or the clock). ${REPO}`,
  },
  notfound: {
    emoji: "🧭",
    title: "Server not found",
    body: "The todo Worker isn't answering at this address. Check the deploy.",
  },
  unauthorized: {
    emoji: "🔒",
    title: "Access token mismatch",
    body: "Re-run scripts/kindle.sh deploy to refresh the token.",
  },
  server: {
    emoji: "💥",
    title: "Server error",
    body: "The todo Worker hit an error. Retrying…",
  },
  battery: {
    emoji: "🔌",
    title: "Battery low",
    body: "The charger seems to be off — plug the Kindle back in.",
  },
};

/** The device pre-downloads exactly these (the Worker-unreachable set). */
export const DEVICE_ERROR_KINDS: readonly DeviceErrorKind[] = [
  "nowifi",
  "notfound",
  "unauthorized",
  "server",
  "battery",
];

/**
 * Map a provider/backend failure to the screen to show. Duck-typed on the
 * error's `name`/`status`/`body` so this module stays dependency-free.
 *
 * A failed token refresh is NOT automatically an expired sign-in: the token
 * endpoint answers non-OK for throttling and outages too, and `invalid_client`
 * means *our* app secret died, which no amount of re-consenting fixes. Only
 * the OAuth error code in the body can tell these apart, so read it:
 *   - invalid_grant                 -> sign-in expired (auth)
 *   - invalid_client / unauthorized_client -> app credentials (credentials)
 *   - any other token failure       -> backend not responding
 *   - Graph 404 (list deleted)      -> list gone
 *   - Graph 401/403                 -> auth
 *   - anything else (5xx/429/net)   -> backend not responding
 */
export function classifyProviderError(err: unknown): WorkerErrorKind {
  const e = err as { name?: unknown; status?: unknown; body?: unknown };
  const name = typeof e?.name === "string" ? e.name : "";
  const status = Number(e?.status);
  if (name === "TokenRefreshError") {
    switch (oauthErrorCode(e?.body)) {
      case "invalid_grant":
        return "auth";
      case "invalid_client":
      case "unauthorized_client":
        return "credentials";
      default:
        // 429, 5xx, a proxy's HTML error page: transient until proven otherwise.
        return "backend";
    }
  }
  if (name === "GraphApiError") {
    if (status === 404) return "list";
    if (status === 401 || status === 403) return "auth";
  }
  return "backend";
}

/** Pull the OAuth2 `error` code out of a token-endpoint body, if it has one. */
function oauthErrorCode(body: unknown): string {
  if (typeof body !== "string") return "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : "";
  } catch {
    return "";
  }
}
