import type { Channel } from "../types";
import { isPodcastChannelId, isRadioStationChannelId } from "./recordableStream";
import type { EqPresetId } from "./eqPresets";
import { loadUiSession, saveUiSession } from "./uiSessionStorage";

export type EqPageScope = "library" | "podcast" | "radio";

export function eqPageScopeForChannel(channel: Channel | null | undefined): EqPageScope | null {
  if (!channel) return null;
  if (
    channel.libraryTrackId?.trim() &&
    channel.url?.trim().toLowerCase().startsWith("blob:")
  ) {
    return "library";
  }
  if (isPodcastChannelId(channel.id)) return "podcast";
  if (isRadioStationChannelId(channel.id)) return "radio";
  return null;
}

export function loadEqSettingsForScope(scope: EqPageScope): {
  preset: EqPresetId;
  customGains: number[];
} {
  const s = loadUiSession();
  switch (scope) {
    case "library":
      return { preset: s.libraryEqPreset, customGains: [...s.libraryEqCustomGains] };
    case "podcast":
      return { preset: s.podcastEqPreset, customGains: [...s.podcastEqCustomGains] };
    case "radio":
      return { preset: s.radioEqPreset, customGains: [...s.radioEqCustomGains] };
  }
}

export function saveEqSettingsForScope(
  scope: EqPageScope,
  partial: { preset?: EqPresetId; customGains?: number[] }
): void {
  switch (scope) {
    case "library":
      saveUiSession({
        libraryEqPreset: partial.preset,
        libraryEqCustomGains: partial.customGains,
      });
      break;
    case "podcast":
      saveUiSession({
        podcastEqPreset: partial.preset,
        podcastEqCustomGains: partial.customGains,
      });
      break;
    case "radio":
      saveUiSession({
        radioEqPreset: partial.preset,
        radioEqCustomGains: partial.customGains,
      });
      break;
  }
}
