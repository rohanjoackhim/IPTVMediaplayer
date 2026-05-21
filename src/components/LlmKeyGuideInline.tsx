import { LLM_KEY_SETUP_HINT, promptLlmApiKeySetup } from "../utils/llmApiKeyGuide";
import "./LlmKeyGuideInline.css";

export interface LlmKeyGuideInlineProps {
  message?: string;
  className?: string;
}

/** Short hint with a button that opens Settings → LLM API keys. */
export function LlmKeyGuideInline({ message, className }: LlmKeyGuideInlineProps) {
  return (
    <p className={`llm-key-guide${className ? ` ${className}` : ""}`} role="status">
      <span>{message ?? LLM_KEY_SETUP_HINT}</span>{" "}
      <button type="button" className="llm-key-guide-link" onClick={() => promptLlmApiKeySetup()}>
        Open Settings
      </button>
    </p>
  );
}
