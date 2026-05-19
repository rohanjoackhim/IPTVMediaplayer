const ALLOWED_MEDIA_TAGS = new Set(["img", "figure", "picture", "svg"]);
const ALLOWED_MEDIA_ATTRS = new Set([
  "src",
  "alt",
  "width",
  "height",
  "viewbox",
  "xmlns",
  "role",
  "aria-hidden",
  "aria-label",
  "preserveaspectratio",
]);

function isUnsafeUrl(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v.startsWith("javascript:") || v.startsWith("data:text/html");
}

function sanitizeElement(el: Element): void {
  const tag = el.tagName.toLowerCase();
  if (!ALLOWED_MEDIA_TAGS.has(tag)) {
    el.remove();
    return;
  }
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on") || !ALLOWED_MEDIA_ATTRS.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === "src" && isUnsafeUrl(attr.value)) {
      el.removeAttribute(attr.name);
    }
  }
  el.querySelectorAll("script, foreignObject, iframe, object, embed, style, link").forEach((node) => node.remove());
  for (const child of [...el.children]) sanitizeElement(child);
}

/** Strip scripts, event handlers, and non-media markup from EPUB chapter HTML before render. */
export function sanitizeEpubMediaHtml(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html || "<p></p>", "text/html");
  doc.querySelectorAll("script, style, noscript, iframe, object, embed, link, meta, base").forEach((node) => node.remove());
  const media = Array.from(doc.body.querySelectorAll("img, svg, figure, picture"));
  for (const node of media) sanitizeElement(node);
  return media.map((node) => node.outerHTML).join("");
}
