import { describe, it, expect } from "vitest";
import { classifyProviderError, ERROR_SCREENS, DEVICE_ERROR_KINDS } from "../src/errors";

// Minimal stand-ins matching the shape the classifier duck-types on.
function graphError(status: number) {
  return Object.assign(new Error("graph"), { name: "GraphApiError", status });
}
function tokenError(status: number) {
  return Object.assign(new Error("token"), { name: "TokenRefreshError", status });
}

describe("classifyProviderError", () => {
  it("maps a refresh-token failure to the sign-in-expired screen", () => {
    expect(classifyProviderError(tokenError(400))).toBe("auth");
    expect(classifyProviderError(tokenError(401))).toBe("auth");
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
