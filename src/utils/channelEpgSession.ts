import type { EpgProgramme } from "./xmltvParser";

export const CHANNEL_EPG_UPDATED_EVENT = "iptv-channel-epg-updated";

export interface ChannelEpgUpdatedDetail {
  channelId: string;
  programmes: EpgProgramme[];
  source: string;
  message?: string;
}

export interface ChannelEpgCachedResult {
  programmes: EpgProgramme[];
  source: string;
  message?: string;
  fetchedAt: number;
}

const cache = new Map<string, ChannelEpgCachedResult>();

export function getChannelEpgCache(channelId: string): ChannelEpgCachedResult | null {
  return cache.get(channelId) ?? null;
}

export function setChannelEpgCache(
  channelId: string,
  result: Omit<ChannelEpgCachedResult, "fetchedAt">
): void {
  const entry: ChannelEpgCachedResult = { ...result, fetchedAt: Date.now() };
  cache.set(channelId, entry);
  window.dispatchEvent(
    new CustomEvent<ChannelEpgUpdatedDetail>(CHANNEL_EPG_UPDATED_EVENT, {
      detail: {
        channelId,
        programmes: result.programmes,
        source: result.source,
        message: result.message,
      },
    })
  );
}
