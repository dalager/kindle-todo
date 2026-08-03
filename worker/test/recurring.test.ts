import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIMEZONE,
  isLocalMidnight,
  isRecurring,
  localHour,
  resetRecurring,
} from "../src/recurring";
import type { Todo, TodoListInfo, TodoProvider } from "../src/providers/types";

/** A TodoProvider whose completed list is fixed and whose reopens are recorded. */
function fakeProvider(
  completed: Todo[],
  reopen: (taskId: string) => Promise<void> = async () => {},
): TodoProvider & { reopened: string[] } {
  const reopened: string[] = [];
  return {
    reopened,
    defaultListId: "L1",
    lists: async (): Promise<TodoListInfo[]> => [{ id: "L1", name: "Familietodo" }],
    title: async () => "Familietodo",
    list: async () => [],
    completed: async () => completed,
    reopen: async (taskId: string) => {
      await reopen(taskId);
      reopened.push(taskId);
    },
  };
}

const done = (id: string, text: string): Todo => ({ id, text, done: true });

describe("isRecurring", () => {
  it("matches the marker anywhere in the title", () => {
    expect(isRecurring("* Opvask")).toBe(true);
    expect(isRecurring("Opvask *")).toBe(true);
    expect(isRecurring("Tøm *opvaskemaskine*")).toBe(true);
  });

  it("leaves ordinary one-shot tasks alone", () => {
    expect(isRecurring("Book tandlæge")).toBe(false);
    expect(isRecurring("")).toBe(false);
  });
});

describe("isLocalMidnight", () => {
  // The whole point of the two-cron setup: exactly one UTC hour is local
  // midnight, and which one flips with DST.
  it("picks 22:00 UTC as midnight during summer time (CEST, +2)", () => {
    expect(isLocalMidnight(Date.parse("2026-07-15T22:00:00Z"), DEFAULT_TIMEZONE)).toBe(true);
    expect(isLocalMidnight(Date.parse("2026-07-15T23:00:00Z"), DEFAULT_TIMEZONE)).toBe(false);
  });

  it("picks 23:00 UTC as midnight during winter time (CET, +1)", () => {
    expect(isLocalMidnight(Date.parse("2026-01-15T23:00:00Z"), DEFAULT_TIMEZONE)).toBe(true);
    expect(isLocalMidnight(Date.parse("2026-01-15T22:00:00Z"), DEFAULT_TIMEZONE)).toBe(false);
  });

  it("resolves midnight as hour 0, not 24", () => {
    expect(localHour(Date.parse("2026-07-15T22:00:00Z"), DEFAULT_TIMEZONE)).toBe(0);
  });

  it("honors a different timezone", () => {
    expect(isLocalMidnight(Date.parse("2026-07-15T22:00:00Z"), "UTC")).toBe(false);
    expect(isLocalMidnight(Date.parse("2026-07-15T00:30:00Z"), "UTC")).toBe(true);
  });
});

describe("resetRecurring", () => {
  it("reopens only the completed tasks carrying the marker", async () => {
    const provider = fakeProvider([
      done("T1", "* Opvask"),
      done("T2", "Book tandlæge"),
      done("T3", "Vand blomster *"),
    ]);

    const result = await resetRecurring(provider, "L1");

    expect(provider.reopened).toEqual(["T1", "T3"]);
    expect(result.reopened).toEqual(["* Opvask", "Vand blomster *"]);
    expect(result.scanned).toBe(3);
    expect(result.failed).toEqual([]);
  });

  it("does nothing when no recurring task was completed", async () => {
    const provider = fakeProvider([done("T2", "Book tandlæge")]);
    const result = await resetRecurring(provider, "L1");
    expect(provider.reopened).toEqual([]);
    expect(result.reopened).toEqual([]);
  });

  it("keeps going when one task fails, and reports it", async () => {
    const provider = fakeProvider(
      [done("T1", "* Opvask"), done("T2", "* Vand blomster")],
      async (taskId) => {
        if (taskId === "T1") throw new Error("Graph request failed: 429");
      },
    );

    const result = await resetRecurring(provider, "L1");

    expect(provider.reopened).toEqual(["T2"]); // the survivor still got reopened
    expect(result.reopened).toEqual(["* Vand blomster"]);
    expect(result.failed).toEqual([{ text: "* Opvask", error: "Graph request failed: 429" }]);
  });

  it("passes the selected list through to the provider", async () => {
    const completed = vi.fn(async () => []);
    const provider = { ...fakeProvider([]), completed };
    await resetRecurring(provider, "OTHER-LIST");
    expect(completed).toHaveBeenCalledWith("OTHER-LIST");
  });
});
