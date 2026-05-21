import { describe, expect, it } from "vitest";
import { isMissingLlmKeyMessage, LLM_KEY_SETUP_HINT } from "./llmApiKeyGuide";

describe("isMissingLlmKeyMessage", () => {
  it("detects standard missing-key phrases", () => {
    expect(isMissingLlmKeyMessage(LLM_KEY_SETUP_HINT)).toBe(true);
    expect(isMissingLlmKeyMessage("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY")).toBe(true);
    expect(isMissingLlmKeyMessage("Add an LLM API key in Settings (DeepSeek, Gemini, or OpenAI)")).toBe(
      true
    );
  });

  it("ignores unrelated errors", () => {
    expect(isMissingLlmKeyMessage("EPG not available")).toBe(false);
    expect(isMissingLlmKeyMessage(null)).toBe(false);
  });
});
