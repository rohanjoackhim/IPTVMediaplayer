export interface RadioCaptionTranslateJob {
  segmentId: number;
  text: string;
  targetCode: string;
}

export type RadioCaptionTranslateRunner = (
  job: RadioCaptionTranslateJob,
  signal: AbortSignal
) => Promise<void>;

/**
 * Serial queue: one in-flight request; coalesces rapid updates per segment id.
 * Different segments are all translated (not dropped) in FIFO order.
 */
export function createRadioCaptionTranslateQueue(run: RadioCaptionTranslateRunner) {
  let draining = false;
  const pendingBySegment = new Map<number, RadioCaptionTranslateJob>();
  const fifo: number[] = [];
  let activeAbort: AbortController | null = null;

  const enqueueSegment = (job: RadioCaptionTranslateJob) => {
    pendingBySegment.set(job.segmentId, job);
    if (!fifo.includes(job.segmentId)) fifo.push(job.segmentId);
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (fifo.length > 0) {
        const segmentId = fifo.shift()!;
        let job: RadioCaptionTranslateJob | undefined;
        while (true) {
          const next = pendingBySegment.get(segmentId);
          if (!next) break;
          job = next;
          pendingBySegment.delete(segmentId);
        }
        if (!job) continue;
        activeAbort?.abort();
        activeAbort = new AbortController();
        try {
          await run(job, activeAbort.signal);
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") continue;
        }
        if (pendingBySegment.has(segmentId)) fifo.push(segmentId);
      }
    } finally {
      draining = false;
      if (fifo.length > 0) void drain();
    }
  };

  return {
    enqueue(job: RadioCaptionTranslateJob) {
      enqueueSegment(job);
      void drain();
    },
    cancel() {
      pendingBySegment.clear();
      fifo.length = 0;
      activeAbort?.abort();
      activeAbort = null;
    },
  };
}
