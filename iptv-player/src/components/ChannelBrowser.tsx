import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Channel } from "../types";
import { fetchM3uPlaylist } from "../utils/fetchM3uPlaylist";
import { favoriteKeyForChannel } from "../utils/favoritesStorage";
import "./ChannelBrowser.css";

const ROW_H = 52;
const OVERSCAN = 12;

function useGroups(channels: Channel[]) {
  return useMemo(() => {
    const s = new Set<string>();
    for (const c of channels) {
      if (c.group?.trim()) s.add(c.group.trim());
    }
    return ["All groups", ...Array.from(s).sort((a, b) => a.localeCompare(b))];
  }, [channels]);
}

export interface ChannelBrowserProps {
  channels: Channel[];
  channelCount: number;
  activeId: string | null;
  onSelect: (c: Channel) => void;
  onLoadM3U: (text: string, replace: boolean) => void;
  onClearList: () => void;
  parseMessage: string | null;
  onPlaylistMessage: (message: string | null) => void;
  favoriteUrls: Set<string>;
  onToggleFavoriteChannel: (c: Channel) => void;
}

type ListTab = "all" | "favorites";

export function ChannelBrowser({
  channels,
  channelCount,
  activeId,
  onSelect,
  onLoadM3U,
  onClearList,
  parseMessage,
  onPlaylistMessage,
  favoriteUrls,
  onToggleFavoriteChannel,
}: ChannelBrowserProps) {
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All groups");
  const [listTab, setListTab] = useState<ListTab>("all");
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const groups = useGroups(channels);

  const toggleFavorite = useCallback(
    (c: Channel, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onToggleFavoriteChannel(c);
    },
    [onToggleFavoriteChannel]
  );

  const isFavorite = useCallback((c: Channel) => favoriteUrls.has(favoriteKeyForChannel(c)), [favoriteUrls]);

  const tabFiltered = useMemo(() => {
    if (listTab === "favorites") {
      return channels.filter((c) => favoriteUrls.has(favoriteKeyForChannel(c)));
    }
    return channels;
  }, [channels, listTab, favoriteUrls]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tabFiltered.filter((c) => {
      if (group !== "All groups" && (c.group?.trim() || "") !== group) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.group?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [tabFiltered, query, group]);

  const totalH = filtered.length * ROW_H;

  const { start, end } = useMemo(() => {
    const el = scrollRef.current;
    const h = el?.clientHeight ?? 600;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const visible = Math.ceil(h / ROW_H) + OVERSCAN * 2;
    const endIdx = Math.min(filtered.length, startIdx + visible);
    return { start: startIdx, end: endIdx };
  }, [scrollTop, filtered.length]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [query, group, channels.length, listTab]);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      onLoadM3U(text, false);
    };
    reader.readAsText(file, "UTF-8");
  };

  const loadPlaylistFromUrl = async (replace: boolean) => {
    const trimmed = playlistUrl.trim();
    if (!trimmed) {
      onPlaylistMessage("Enter an M3U or M3U8 playlist URL (https://…).");
      return;
    }
    onPlaylistMessage("Loading playlist from URL…");
    setUrlBusy(true);
    try {
      const text = await fetchM3uPlaylist(trimmed);
      onLoadM3U(text, replace);
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : "Could not load playlist from URL. In production builds, the server must allow CORS or use a file.";
      onPlaylistMessage(msg);
    } finally {
      setUrlBusy(false);
    }
  };

  const favCount = favoriteUrls.size;

  const favoritesInLibrary = useMemo(
    () => channels.filter((c) => favoriteUrls.has(favoriteKeyForChannel(c))).length,
    [channels, favoriteUrls]
  );

  return (
    <div className="browser-root">
      <header className="browser-header">
        <h1 className="browser-title">IPTV</h1>
        <p className="browser-sub">
          {channelCount} channels in library · {favCount} favorite{favCount === 1 ? "" : "s"} saved · left: browse ·
          right: play
        </p>
        <div className="toolbar">
          <input
            ref={fileRef}
            type="file"
            accept=".m3u,.m3u8,text/plain"
            className="hidden-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = "";
            }}
          />
          <button type="button" className="file-btn" onClick={() => fileRef.current?.click()}>
            + Add M3U
          </button>
          <input
            type="file"
            accept=".m3u,.m3u8,text/plain"
            className="hidden-input"
            id="m3u-replace"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                const reader = new FileReader();
                reader.onload = () => {
                  const text = typeof reader.result === "string" ? reader.result : "";
                  onLoadM3U(text, true);
                };
                reader.readAsText(f, "UTF-8");
              }
              e.target.value = "";
            }}
          />
          <label className="file-btn" htmlFor="m3u-replace" style={{ cursor: "pointer" }}>
            Replace M3U
          </label>
          <button type="button" className="btn-ghost" onClick={onClearList}>
            Clear list
          </button>
        </div>
        <div className="url-row">
          <input
            className="playlist-url-input"
            type="url"
            inputMode="url"
            placeholder="https://example.com/playlist.m3u"
            value={playlistUrl}
            onChange={(e) => setPlaylistUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void loadPlaylistFromUrl(e.shiftKey);
            }}
            autoComplete="off"
            spellCheck={false}
            disabled={urlBusy}
            aria-label="M3U playlist URL"
          />
          <button
            type="button"
            className="url-btn"
            disabled={urlBusy}
            onClick={() => void loadPlaylistFromUrl(false)}
          >
            Add from URL
          </button>
          <button
            type="button"
            className="url-btn"
            disabled={urlBusy}
            onClick={() => void loadPlaylistFromUrl(true)}
          >
            Replace from URL
          </button>
        </div>
        {parseMessage ? <div className="message-bar">{parseMessage}</div> : null}
      </header>

      <div className="browser-tabs" role="tablist" aria-label="Channel list">
        <button
          type="button"
          role="tab"
          aria-selected={listTab === "all"}
          className={`browser-tab${listTab === "all" ? " active" : ""}`}
          onClick={() => setListTab("all")}
        >
          All channels
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={listTab === "favorites"}
          className={`browser-tab${listTab === "favorites" ? " active" : ""}`}
          onClick={() => setListTab("favorites")}
        >
          Favorites{favoritesInLibrary > 0 ? ` (${favoritesInLibrary})` : ""}
        </button>
      </div>

      <div className="filters">
        <input
          className="search-input"
          placeholder="Search channels…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <select className="group-select" value={group} onChange={(e) => setGroup(e.target.value)}>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>

      <div className="channel-scroll" ref={scrollRef} onScroll={onScroll}>
        {filtered.length === 0 ? (
          <div className="empty-state">
            {listTab === "favorites" ? (
              favoritesInLibrary === 0 ? (
                favCount > 0 ? (
                  <>
                    You have <strong>{favCount}</strong> saved favorite{favCount === 1 ? "" : "s"}, but none match the
                    current playlist. Replace or add your M3U to bring those channels back, or open{" "}
                    <strong>All channels</strong> to star new ones.
                  </>
                ) : (
                  <>
                    No favorites yet. Open <strong>All channels</strong> and click the <strong>★</strong> on a row to
                    add it here. Favorites are stored in this browser by stream URL.
                  </>
                )
              ) : (
                <>
                  No favorites match your search or group filter. Try clearing the search box or choosing{" "}
                  <strong>All groups</strong>.
                </>
              )
            ) : (
              <>
                No channels match your filters. Load an M3U playlist (IPTV providers usually give you a URL or file
                with hundreds of <code>#EXTINF</code> entries).
              </>
            )}
          </div>
        ) : (
          <div className="channel-scroll-inner" style={{ height: totalH }}>
            {filtered.slice(start, end).map((c, i) => {
              const index = start + i;
              const top = index * ROW_H;
              const fav = isFavorite(c);
              return (
                <div
                  key={c.id}
                  className={`channel-row${c.id === activeId ? " active" : ""}`}
                  style={{ top }}
                >
                  <button type="button" className="channel-row-hit" onClick={() => onSelect(c)}>
                    {c.logo ? (
                      <img className="channel-logo" src={c.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="channel-logo placeholder">TV</span>
                    )}
                    <span className="channel-meta">
                      <span className="channel-name">{c.name}</span>
                      {c.group ? <span className="channel-group">{c.group}</span> : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`fav-btn${fav ? " fav-btn--on" : ""}`}
                    onClick={(e) => toggleFavorite(c, e)}
                    title={fav ? "Remove from favorites" : "Add to favorites"}
                    aria-label={fav ? `Remove ${c.name} from favorites` : `Add ${c.name} to favorites`}
                    aria-pressed={fav}
                  >
                    ★
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
