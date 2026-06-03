import type { ChannelEpgGuideApi } from "../hooks/useChannelEpgGuide";
import "./ChannelEpgGuide.css";

export interface ChannelEpgToolbarProps {
  guide: ChannelEpgGuideApi;
}

/** EPG / Web / LLM — lives on the live TV toolbar row. */
export function ChannelEpgToolbar({ guide }: ChannelEpgToolbarProps) {
  const { panelOpen, lookupBusy, handlePrimaryEpgClick, runLookup } = guide;

  return (
    <div className="channel-epg-toolbar" role="group" aria-label="Program guide lookup">
      <button
        type="button"
        className={`channel-epg-lookup-inline-btn channel-epg-lookup-inline-btn--primary${
          panelOpen ? " channel-epg-lookup-inline-btn--open" : ""
        }`}
        disabled={lookupBusy && !panelOpen}
        aria-expanded={panelOpen}
        title={panelOpen ? "Hide program guide" : "Show program guide"}
        onClick={handlePrimaryEpgClick}
      >
        {lookupBusy && panelOpen ? "…" : panelOpen ? "Close" : "EPG"}
      </button>
      <button
        type="button"
        className="channel-epg-lookup-inline-btn"
        disabled={lookupBusy}
        onClick={() => void runLookup("online")}
        title="Free XMLTV on the web"
      >
        Web
      </button>
      <button
        type="button"
        className="channel-epg-lookup-inline-btn channel-epg-lookup-inline-btn--llm"
        disabled={lookupBusy}
        onClick={() => void runLookup("llm")}
        title="Estimated schedule via LLM"
      >
        LLM
      </button>
    </div>
  );
}
