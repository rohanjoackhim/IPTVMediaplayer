/**
 * Parse JSON from `translate.googleapis.com/translate_a/single?client=gtx&...`.
 * Undocumented web endpoint; may change. Concatenates sentence fragments from index [0][*][0].
 */
export function parseGoogleGtxTranslate(data: unknown): string {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Bad Google Translate response.");
  }
  const head = data[0];
  if (!Array.isArray(head)) {
    throw new Error("Bad Google Translate response.");
  }
  let out = "";
  for (const item of head) {
    if (Array.isArray(item) && typeof item[0] === "string") {
      out += item[0];
    }
  }
  if (!out) {
    throw new Error("Google Translate response had no text.");
  }
  return out;
}
