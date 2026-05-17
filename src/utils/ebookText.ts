import JSZip from "jszip";

export interface EbookTextResult {
  title: string;
  text: string;
  format: "pdf" | "epub" | "html" | "text";
  pages: string[];
}

declare global {
  interface Array<T> {
    toHex?: () => string;
  }

  interface Uint8Array {
    toHex?: () => string;
  }
}

function fileBaseName(name: string): string {
  return name.replace(/\.[^/.]+$/, "").trim() || name || "Ebook";
}

function normalizeReadableText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textQualityScore(text: string): number {
  const t = text.trim();
  if (!t) return -1;
  const replacementCount = (t.match(/\uFFFD/g) ?? []).length;
  const letterCount = (t.match(/\p{L}/gu) ?? []).length;
  const controlCount = (t.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
  return letterCount - replacementCount * 40 - controlCount * 10;
}

function replacementRatio(text: string): number {
  const visible = text.replace(/\s/g, "");
  if (!visible) return 1;
  return (visible.match(/\uFFFD/g) ?? []).length / visible.length;
}

function assertReadableText(text: string, label: string) {
  const normalized = normalizeReadableText(text);
  if (!normalized) throw new Error(`No readable text was found in this ${label}.`);
  if (replacementRatio(normalized) > 0.02) {
    throw new Error(
      `The ${label} text could not be decoded into readable words. This often happens with scanned PDFs or PDFs that use custom fonts without Unicode text maps. Try an EPUB/TXT version or run OCR on the PDF first.`
    );
  }
  return normalized;
}

async function decodeTextFile(file: File): Promise<string> {
  const data = await file.arrayBuffer();
  const encodings = ["utf-8", "windows-1252", "iso-8859-1", "utf-16le", "utf-16be"];
  let best = "";
  let bestScore = -Infinity;
  for (const enc of encodings) {
    try {
      const decoded = normalizeReadableText(new TextDecoder(enc).decode(data));
      const score = textQualityScore(decoded);
      if (score > bestScore) {
        bestScore = score;
        best = decoded;
      }
    } catch {
      /* unsupported encoding label */
    }
  }
  return best || normalizeReadableText(await file.text());
}

function bytesToHex(this: ArrayLike<number>): string {
  let out = "";
  for (let i = 0; i < this.length; i++) {
    out += (this[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

function installPdfJsCompatibilityShims() {
  if (!Uint8Array.prototype.toHex) {
    Object.defineProperty(Uint8Array.prototype, "toHex", {
      value: bytesToHex,
      configurable: true,
    });
  }
  if (!Array.prototype.toHex) {
    Object.defineProperty(Array.prototype, "toHex", {
      value: bytesToHex,
      configurable: true,
    });
  }
}

function htmlToText(html: string): string {
  if (typeof DOMParser === "undefined") {
    return normalizeReadableText(html.replace(/<[^>]+>/g, " "));
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, svg").forEach((node) => node.remove());
  return normalizeReadableText(doc.body?.textContent ?? doc.documentElement.textContent ?? "");
}

function xmlAttr(raw: string, name: string): string | null {
  const m = raw.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return m?.[1] ? m[1] : null;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx + 1) : "";
}

function resolveZipPath(baseDir: string, href: string): string {
  const parts = `${baseDir}${href}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

async function epubToText(file: File): Promise<EbookTextResult> {
  const zip = await JSZip.loadAsync(file);
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const rootfile = container ? xmlAttr(container, "full-path") : null;
  if (!rootfile) throw new Error("Could not find the EPUB package file.");

  const opf = await zip.file(rootfile)?.async("string");
  if (!opf) throw new Error("Could not read the EPUB package file.");

  const titleMatch = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
  const title = normalizeReadableText(titleMatch?.[1]?.replace(/<[^>]+>/g, "") ?? "") || fileBaseName(file.name);
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0];
    const id = xmlAttr(tag, "id");
    const href = xmlAttr(tag, "href");
    if (id && href) manifest.set(id, href);
  }

  const chunks: string[] = [];
  const base = dirname(rootfile);
  for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = xmlAttr(m[0], "idref");
    const href = idref ? manifest.get(idref) : null;
    if (!href) continue;
    const path = resolveZipPath(base, href);
    if (!/\.(xhtml|html|htm|xml)$/i.test(path)) continue;
    const html = await zip.file(path)?.async("string");
    if (html) chunks.push(htmlToText(html));
  }

  const pages = chunks.map((chunk) => normalizeReadableText(chunk)).filter(Boolean);
  const text = assertReadableText(pages.join("\n\n"), "EPUB");
  return { title, text, format: "epub", pages: pages.length ? pages : [text] };
}

async function pdfToText(file: File): Promise<EbookTextResult> {
  installPdfJsCompatibilityShims();
  const [{ getDocument }, pdfWorker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ]);
  (globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = pdfWorker;

  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data, isEvalSupported: false, useWorkerFetch: false } as Parameters<typeof getDocument>[0]).promise;
  const pages: string[] = [];

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const pageText = (content.items as Array<{ str?: unknown }>)
      .map((item) => (typeof item.str === "string" ? item.str : ""))
      .join(" ");
    const cleaned = normalizeReadableText(pageText);
    if (cleaned) pages.push(cleaned);
  }

  const text = assertReadableText(pages.join("\n\n"), "PDF");
  return { title: fileBaseName(file.name), text, format: "pdf", pages: pages.length ? pages : [text] };
}

export async function extractEbookText(file: File): Promise<EbookTextResult> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".epub")) return epubToText(file);
  if (lower.endsWith(".pdf") || file.type === "application/pdf") return pdfToText(file);
  if (/\.(html|htm|xhtml)$/i.test(lower) || /html/i.test(file.type)) {
    const text = assertReadableText(htmlToText(await decodeTextFile(file)), "HTML file");
    return { title: fileBaseName(file.name), text, format: "html", pages: [text] };
  }
  if (/\.(txt|md|markdown|text)$/i.test(lower) || /^text\//i.test(file.type)) {
    const text = assertReadableText(await decodeTextFile(file), "text file");
    return { title: fileBaseName(file.name), text, format: "text", pages: [text] };
  }
  throw new Error("Unsupported ebook file. Use PDF, EPUB, TXT, MD, HTML, or XHTML.");
}
