import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave } from "./autosave";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("editor autosave", () => {
  it("flushes the latest pending edit immediately when leaving the editor", async () => {
    const save = vi.fn(async (_value: string) => {});
    const saver = createAutosave(save);
    saver.schedule("first edit");
    saver.schedule("last edit");
    await saver.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith("last edit");
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("serializes writes so a slow older request cannot replace newer edits", async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => { finishFirst = resolve; });
    const save = vi.fn<(value: string) => Promise<void>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const saver = createAutosave(save);
    saver.schedule("older");
    await vi.advanceTimersByTimeAsync(800);
    saver.schedule("newer");
    const flushed = saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    finishFirst();
    await flushed;
    expect(save.mock.calls).toEqual([["older"], ["newer"]]);
  });

  it("retains a failed draft and retries it when switching sheets", async () => {
    const save = vi.fn<(value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const saver = createAutosave(save);
    saver.schedule("first");
    await vi.advanceTimersByTimeAsync(800);
    await saver.flush();
    expect(save.mock.calls).toEqual([["first"], ["first"]]);
  });

  it("preserves a newer pending draft when an earlier write fails", async () => {
    let failFirst!: (error: Error) => void;
    const first = new Promise<void>((_resolve, reject) => { failFirst = reject; });
    const save = vi.fn<(value: string) => Promise<void>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const saver = createAutosave(save);
    saver.schedule("older");
    await vi.advanceTimersByTimeAsync(800);
    saver.schedule("newer");
    const flushed = saver.flush();
    failFirst(new Error("offline"));
    await flushed;
    expect(save.mock.calls).toEqual([["older"], ["newer"]]);
  });
});
