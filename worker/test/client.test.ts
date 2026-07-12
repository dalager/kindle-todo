import { afterEach, describe, expect, it, vi } from "vitest";
import { MicrosoftTodoClient } from "../src/providers/microsoft/client";
import { TokenManager, kvTokenStore, type StoredToken } from "../src/providers/microsoft/auth";

const CONFIG = {
  clientId: "cid",
  clientSecret: "secret",
  refreshToken: "seed-refresh-token",
};

/** Build a fetch mock that dispatches on URL. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  });
}

const tokenResponse = (accessToken = "access-1", refreshToken = "rotated-refresh") =>
  new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TokenManager", () => {
  it("exchanges the bootstrap refresh token for an access token", async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toContain("/oauth2/v2.0/token");
      return tokenResponse("access-abc");
    });
    vi.stubGlobal("fetch", fetchMock);

    const tm = new TokenManager(CONFIG);
    expect(await tm.getAccessToken()).toBe("access-abc");

    const body = fetchMock.mock.calls[0][1]!.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("seed-refresh-token");
  });

  it("caches the access token and does not refresh twice", async () => {
    const fetchMock = mockFetch(() => tokenResponse());
    vi.stubGlobal("fetch", fetchMock);

    const tm = new TokenManager(CONFIG);
    await tm.getAccessToken();
    await tm.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("persists the rotated refresh token to the store", async () => {
    const fetchMock = mockFetch(() => tokenResponse("a", "rotated-xyz"));
    vi.stubGlobal("fetch", fetchMock);

    const mem = new Map<string, string>();
    const kv = {
      get: async (k: string) => mem.get(k) ?? null,
      put: async (k: string, v: string) => void mem.set(k, v),
    };
    const tm = new TokenManager({ ...CONFIG, tokenStore: kvTokenStore(kv) });
    await tm.getAccessToken();

    const stored = JSON.parse(mem.get("ms-todo-token")!) as StoredToken;
    expect(stored.refresh_token).toBe("rotated-xyz");
  });

  it("throws TokenRefreshError on a non-OK token response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => new Response("invalid_grant", { status: 400 })),
    );
    const tm = new TokenManager(CONFIG);
    await expect(tm.getAccessToken()).rejects.toThrow(/Token refresh failed \(400\)/);
  });
});

describe("MicrosoftTodoClient", () => {
  it("listLists maps the Graph collection", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("/token")) return tokenResponse();
      expect(url).toBe("https://graph.microsoft.com/v1.0/me/todo/lists");
      return new Response(
        JSON.stringify({
          value: [
            {
              id: "L1",
              displayName: "Groceries",
              isOwner: true,
              isShared: false,
              wellknownListName: "none",
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new MicrosoftTodoClient(CONFIG);
    const lists = await client.listLists();
    expect(lists).toEqual([
      {
        id: "L1",
        displayName: "Groceries",
        isOwner: true,
        isShared: false,
        wellKnownListName: "none",
      },
    ]);
  });

  it("listTasks filters out completed tasks by default", async () => {
    let tasksUrl = "";
    const fetchMock = mockFetch((url) => {
      if (url.includes("/token")) return tokenResponse();
      tasksUrl = url;
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await new MicrosoftTodoClient(CONFIG).listTasks("L1");
    expect(tasksUrl).toContain("/me/todo/lists/L1/tasks");
    expect(decodeURIComponent(tasksUrl)).toContain("status ne 'completed'");
    expect(tasksUrl).toContain("$top=100");
  });

  it("listTasks with onlyCompleted uses the completed filter", async () => {
    let tasksUrl = "";
    const fetchMock = mockFetch((url) => {
      if (url.includes("/token")) return tokenResponse();
      tasksUrl = url;
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await new MicrosoftTodoClient(CONFIG).listTasks("L1", { onlyCompleted: true });
    expect(decodeURIComponent(tasksUrl)).toContain("status eq 'completed'");
  });

  it("listTasks normalizes timestamps and note", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("/token")) return tokenResponse();
      return new Response(
        JSON.stringify({
          value: [
            {
              id: "T1",
              title: "Buy milk",
              status: "notStarted",
              importance: "normal",
              isReminderOn: false,
              body: { content: "2%", contentType: "text" },
              createdDateTime: "2024-01-25T10:00:00.0000000Z",
              lastModifiedDateTime: "2024-01-25T10:00:00Z",
              dueDateTime: { dateTime: "2024-02-01T09:00:00.0000000", timeZone: "UTC" },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const [task] = await new MicrosoftTodoClient(CONFIG).listTasks("L1");
    expect(task.note).toBe("2%");
    expect(task.createdDateTime).toBe("2024-01-25T10:00:00.000Z");
    expect(task.dueDateTime).toBe("2024-02-01T09:00:00.000Z");
    expect(task.reminderDateTime).toBeNull();
  });

  it("completeTask PATCHes status completed", async () => {
    let method = "";
    let payload: unknown;
    const fetchMock = mockFetch((url, init) => {
      if (url.includes("/token")) return tokenResponse();
      method = init!.method!;
      payload = JSON.parse(init!.body as string);
      return new Response(
        JSON.stringify({
          id: "T1",
          title: "Buy milk",
          status: "completed",
          importance: "normal",
          isReminderOn: false,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const task = await new MicrosoftTodoClient(CONFIG).completeTask("L1", "T1");
    expect(method).toBe("PATCH");
    expect((payload as { status: string }).status).toBe("completed");
    expect(task.status).toBe("completed");
  });

  it("surfaces Graph errors with status", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("/token")) return tokenResponse();
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new MicrosoftTodoClient(CONFIG).listTasks("bad")).rejects.toMatchObject({
      status: 404,
    });
  });
});
