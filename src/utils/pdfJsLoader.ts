import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfJsPromise: Promise<PdfJsModule> | null = null;

/** Load pdf.js once with a Vite-resolved worker URL (required for Electron builds). */
export function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      const [pdfjs, workerModule] = await Promise.all([
        import("pdfjs-dist/legacy/build/pdf.mjs"),
        import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      (globalThis as typeof globalThis & { pdfjsWorker?: { WorkerMessageHandler?: unknown } }).pdfjsWorker =
        workerModule;
      return pdfjs;
    })();
  }
  return pdfJsPromise;
}
