import { describe, it, expect } from "vitest";
import { classifyProviderError, ERROR_SCREENS, DEVICE_ERROR_KINDS } from "../src/errors";

// Minimal stand-ins matching the shape the classifier duck-types on.
function graphError(status: number) {
  return Object.assign(new Error("graph"), { name: "GraphApiError", status });
}
function tokenError(status: number, error?: string) {
  return Object.assign(new Error("token"), {
    name: "TokenRefreshError",
    status,
    body: error === undefined ? "" : JSON.stringify({ error }),
  });
}

describe("classifyProviderError", () => {
  it("maps only invalid_grant to the sign-in-expired screen", () => {
    expect(classifyProviderError(tokenError(400, "invalid_grant"))).toBe("auth");
  });

  // Regression: AADSTS7000222 (2026-09-19). An expired Azure client secret was
  // shown as "Microsoft sign-in expired", sending the fix at re-consent instead
  // of at secret rotation.
  it("maps invalid_client to the app-credentials screen, not sign-in", () => {
    expect(classifyProviderError(tokenError(401, "invalid_client"))).toBe("credentials");
    expect(classifyProviderError(tokenError(400, "unauthorized_client"))).toBe("credentials");
  });

  // Regression: a throttled or broken token endpoint is not a dead sign-in.
  it("maps other token failures to the backend screen", () => {
    expect(classifyProviderError(tokenError(429, "temporarily_unavailable"))).toBe("backend");
    expect(classifyProviderError(tokenError(503))).toBe("backend");
    expect(classifyProviderError(tokenError(500))).toBe("backend");
  });

  it("maps a deleted/missing list (404) to the list screen", () => {
    expect(classifyProviderError(graphError(404))).toBe("list");
  });

  it("maps Graph 401/403 to the auth screen", () => {
    expect(classifyProviderError(graphError(401))).toBe("auth");
    expect(classifyProviderError(graphError(403))).toBe("auth");
  });

  it("maps 5xx / 429 / unknown errors to the backend screen", () => {
    expect(classifyProviderError(graphError(500))).toBe("backend");
    expect(classifyProviderError(graphError(429))).toBe("backend");
    expect(classifyProviderError(new Error("boom"))).toBe("backend");
    expect(classifyProviderError(undefined)).toBe("backend");
  });
});

describe("ERROR_SCREENS", () => {
  it("has content for every device-side kind the deploy script downloads", () => {
    for (const kind of DEVICE_ERROR_KINDS) {
      expect(ERROR_SCREENS[kind]).toBeTruthy();
      expect(ERROR_SCREENS[kind].title.length).toBeGreaterThan(0);
      expect(ERROR_SCREENS[kind].emoji.length).toBeGreaterThan(0);
    }
  });
});
