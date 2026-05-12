import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import { ChannelBrowser } from "./components/ChannelBrowser";
import { VideoPlayer } from "./components/VideoPlayer";
import { favoriteKeyForChannel, loadFavoriteUrls, saveFavoriteUrls } from "./utils/favoritesStorage";
import { parseM3U } from "./utils/m3uParser";
import type { Channel } from "./types";

const DEMO_CHANNELS: Channel[] = [
  {
    id: "demo-1",
    name: "Big Buck Bunny (HLS demo)",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    group: "Samples",
  },
  {
    id: "demo-2",
    name: "Sintel (HLS, multi-audio)",
    url: "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8",
    group: "Samples",
  },
];

function loadStoredChannels(): Channel[] {
  try {
    const raw = localStorage.getItem("iptv-channels");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Channel[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChannels(channels: Channel[]) {
  try {
    localStorage.setItem("iptv-channels", JSON.stringify(channels));
  } catch {
    /* quota or private mode */
  }
}

export default function App() {
  const [channels, setChannels] = useState<Channel[]>(() => {
    const stored = loadStoredChannels();
    return stored.length ? stored : DEMO_CHANNELS;
  });
  const [active, setActive] = useState<Channel | null>(null);
  const [parseMessage, setParseMessage] = useState<string | null>(null);
  const [favoriteUrls, setFavoriteUrls] = useState<Set<string>>(() => loadFavoriteUrls());

  useEffect(() => {
    saveChannels(channels);
  }, [channels]);

  useEffect(() => {
    saveFavoriteUrls(favoriteUrls);
  }, [favoriteUrls]);

  const toggleFavoriteChannel = useCallback((c: Channel | null) => {
    if (!c?.url?.trim()) return;
    const key = favoriteKeyForChannel(c);
    setFavoriteUrls((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const activeIsFavorite = useMemo(
    () => (active ? favoriteUrls.has(favoriteKeyForChannel(active)) : false),
    [active, favoriteUrls]
  );

  const onLoadM3U = useCallback((text: string, replace: boolean) => {
    const { channels: next, errors } = parseM3U(text);
    if (errors.length && next.length === 0) {
      setParseMessage(errors.join(" "));
      return;
    }
    setParseMessage(
      next.length ? `Loaded ${next.length} channel(s).${errors.length ? " " + errors.join(" ") : ""}` : null
    );
    setChannels((prev) => (replace ? next : [...prev, ...next]));
    setActive((cur) => {
      if (replace) return next[0] ?? null;
      if (!cur && next.length) return next[0];
      return cur;
    });
  }, []);

  const onClearList = useCallback(() => {
    setChannels([]);
    setActive(null);
    setParseMessage("Playlist cleared.");
  }, []);

  const channelCount = useMemo(() => channels.length, [channels]);

  return (
    <div className="app-shell">
      <aside className="browser-pane">
        <ChannelBrowser
          channels={channels}
          channelCount={channelCount}
          activeId={active?.id ?? null}
          onSelect={setActive}
          onLoadM3U={onLoadM3U}
          onClearList={onClearList}
          parseMessage={parseMessage}
          onPlaylistMessage={setParseMessage}
          favoriteUrls={favoriteUrls}
          onToggleFavoriteChannel={toggleFavoriteChannel}
        />
      </aside>
      <main className="player-pane">
        <VideoPlayer
          channel={active}
          isChannelFavorite={activeIsFavorite}
          onToggleChannelFavorite={() => toggleFavoriteChannel(active)}
        />
      </main>
    </div>
  );
}
