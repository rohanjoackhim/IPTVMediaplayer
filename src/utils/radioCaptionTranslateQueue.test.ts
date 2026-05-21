import { describe, expect, it, vi } from "vitest";
import {
  createRadioCaptionTranslateQueue,
  type RadioCaptionTranslateJob,
} from "./radioCaptionTranslateQueue";

describe("createRadioCaptionTranslateQueue", () => {
  it("translates each segment id without dropping other segments", async () => {
    const run = vi.fn(async (_job: RadioCaptionTranslateJob) => {});
    const q = createRadioCaptionTranslateQueue(run);
    q.enqueue({ segmentId: 1, text: "a", targetCode: "en" });
    q.enqueue({ segmentId: 2, text: "b", targetCode: "en" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[0]?.[0]?.segmentId).toBe(1);
    expect(run.mock.calls[1]?.[0]?.segmentId).toBe(2);
  });

  it("ends on the latest text when the same segment is updated quickly", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run = vi.fn(async (_job: RadioCaptionTranslateJob) => {
      await gate;
    });
    const q = createRadioCaptionTranslateQueue(run);
    q.enqueue({ segmentId: 1, text: "draft", targetCode: "en" });
    q.enqueue({ segmentId: 1, text: "final", targetCode: "en" });
    release();
    await vi.waitFor(() => expect(run.mock.calls.at(-1)?.[0]?.text).toBe("final"));
  });
});
