import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Channel } from "../types";
import { favoriteKeyForChannel } from "../utils/favoritesStorage";
import {
  fetchPodcastEpisodes,
  fetchPodcastShows,
  formatPodcastDate,
  formatPodcastDuration,
  podcastEpisodeToChannel,
  PODCAST_COUNTRIES,
  PODCAST_GENRES,
  type PodcastEpisodeRow,
  type PodcastShowRow,
} from "../utils/podcastApi";
import { loadUiSession, saveUiSession, type PodcastListTabPersisted } from "../utils/uiSessionStorage";
import "./PodcastPanel.css";

const SHOW_ROW_H = 42;
const EPISODE_ROW_H = 42;
const OVERSCAN = 12;
const MEDIA_PLAYBACK_TOGGLE_EVENT = "iptv-media-playback-toggle";
const MEDIA_PLAYBACK_STATE_EVENT = "iptv-media-playback-state";

export interface PodcastPanelProps {
  onSelectEpisode: (c: Channel) => void;
  activeLeftId: string | null;
  activeRightId: string | null;
  splitView: boolean;
  favoriteUrls: Set<string>;
  onToggleFavoriteChannel: (c: Channel) => void;
  podcastCountry: string;
  onPodcastCountryChange: (countryCode: string) => void;
  podcastGenreId: number;
  onPodcastGenreChange: (genreId: number) => void;
}

function PodcastArtwork({ url, label }: { url?: string; label: string }) {
  const [failed, setFailed] = useState(false);
  const src = url?.trim();
  if (src && /^https?:\/\//i.test(src) && !failed) {
    return (
      <img
        className="podcast-logo"
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="podcast-logo podcast-logo--placeholder" aria-hidden>
      {label.slice(0, 1).toUpperCase() || "P"}
    </span>
  );
}

export function PodcastPanel({
  onSelectEpisode,
  activeLeftId,
  activeRightId,
  splitView,
  favoriteUrls,
  onToggleFavoriteChannel,
  podcastCountry,
  onPodcastCountryChange,
  podcastGenreId,
  onPodcastGenreChange,
}: PodcastPanelProps) {
  const [shows, setShows] = useState<PodcastShowRow[]>([]);
  const [episodes, setEpisodes] = useState<PodcastEpisodeRow[]>([]);
  const [selectedShow, setSelectedShow] = useState<PodcastShowRow | null>(null);
  const [podcastListTab, setPodcastListTab] = useState<PodcastListTabPersisted>(() => loadUiSession().podcastListTab);
  const [query, setQuery] = useState("");
  const [episodeQuery, setEpisodeQuery] = useState("");
  const [loadingShows, setLoadingShows] = useState(false);
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);
  const [showsErr, setShowsErr] = useState<string | null>(null);
  const [episodesErr, setEpisodesErr] = useState<string | null>(null);
  const [showsRefreshTick, setShowsRefreshTick] = useState(0);
  const [mediaPlaybackState, setMediaPlaybackState] = useState<{ channelId: string; paused: boolean } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);

  const countryCode = useMemo(() => {
    const match = PODCAST_COUNTRIES.find((c) => c.code === podcastCountry);
    return match?.code ?? PODCAST_COUNTRIES[0]?.code ?? "us";
  }, [podcastCountry]);

  const genreName = useMemo(
    () => PODCAST_GENRES.find((g) => g.id === podcastGenreId)?.name ?? "All genres",
    [podcastGenreId]
  );

  useEffect(() => {
    if (selectedShow) return;
    const ac = new AbortController();
    setLoadingShows(true);
    setShowsErr(null);
    void fetchPodcastShows({ countryCode, genreId: podcastGenreId, limit: 200 }, ac.signal)
      .then(setShows)
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setShowsErr(e instanceof Error ? e.message : String(e));
        setShows([]);
      })
      .finally(() => setLoadingShows(false));
    return () => ac.abort();
  }, [countryCode, podcastGenreId, selectedShow, showsRefreshTick]);

  useEffect(() => {
    if (!selectedShow) {
      setEpisodes([]);
      setEpisodesErr(null);
      return;
    }
    const ac = new AbortController();
    setLoadingEpisodes(true);
    setEpisodesErr(null);
    void fetchPodcastEpisodes(selectedShow.collectionId, { countryCode, limit: 50 }, ac.signal)
      .then(setEpisodes)
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setEpisodesErr(e instanceof Error ? e.message : String(e));
        setEpisodes([]);
      })
      .finally(() => setLoadingEpisodes(false));
    return () => ac.abort();
  }, [selectedShow, countryCode]);

  useEffect(() => {
    saveUiSession({ podcastListTab });
  }, [podcastListTab]);

  const episodeChannels = useMemo(
    () =>
      episodes.map((ep) => ({
        ep,
        ch: podcastEpisodeToChannel(ep, selectedShow ?? undefined),
      })),
    [episodes, selectedShow]
  );

  const favoritesInView = useMemo(() => {
    if (selectedShow) {
      return episodeChannels.filter(({ ch }) => favoriteUrls.has(favoriteKeyForChannel(ch))).length;
    }
    return 0;
  }, [selectedShow, episodeChannels, favoriteUrls]);

  const tabFilteredShows = useMemo(() => {
    if (podcastListTab === "favorites") return [];
    return shows;
  }, [shows, podcastListTab]);

  const filteredShows = useMemo(() => {
    if (podcastListTab === "favorites") return tabFilteredShows;
    const q = query.trim().toLowerCase();
    if (!q) return tabFilteredShows;
    return tabFilteredShows.filter((s) => {
      const title = s.collectionName.toLowerCase();
      const author = s.artistName.toLowerCase();
      const genre = (s.primaryGenreName || "").toLowerCase();
      return title.includes(q) || author.includes(q) || genre.includes(q);
    });
  }, [tabFilteredShows, query, podcastListTab]);

  const tabFilteredEpisodes = useMemo(() => {
    if (podcastListTab === "favorites") {
      return episodeChannels.filter(({ ch }) => favoriteUrls.has(favoriteKeyForChannel(ch)));
    }
    return episodeChannels;
  }, [episodeChannels, podcastListTab, favoriteUrls]);

  const filteredEpisodes = useMemo(() => {
    if (podcastListTab === "favorites") return tabFilteredEpisodes;
    const q = episodeQuery.trim().toLowerCase();
    if (!q) return tabFilteredEpisodes;
    return tabFilteredEpisodes.filter(({ ep }) => ep.trackName.toLowerCase().includes(q));
  }, [tabFilteredEpisodes, episodeQuery, podcastListTab]);

  const inEpisodeView = selectedShow != null;
  const rowH = inEpisodeView ? EPISODE_ROW_H : SHOW_ROW_H;
  const filtered = inEpisodeView ? filteredEpisodes : filteredShows;
  const totalH = filtered.length * rowH;

  const { start, end } = useMemo(() => {
    const el = scrollRef.current;
    const h = el?.clientHeight ?? 600;
    const startIdx = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
    const visible = Math.ceil(h / rowH) + OVERSCAN * 2;
    const endIdx = Math.min(filtered.length, startIdx + visible);
    return { start: startIdx, end: endIdx };
  }, [scrollTop, filtered.length, rowH]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || scrollRafRef.current != null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop);
    });
  }, []);

  useEffect(
    () => () => {
      if (scrollRafRef.current != null) window.cancelAnimationFrame(scrollRafRef.current);
    },
    []
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [countryCode, podcastGenreId, query, episodeQuery, podcastListTab, showsRefreshTick, selectedShow?.collectionId]);

  const toggleFavorite = useCallback(
    (ch: Channel, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onToggleFavoriteChannel(ch);
    },
    [onToggleFavoriteChannel]
  );

  const isFavorite = useCallback(
    (ch: Channel) => favoriteUrls.has(favoriteKeyForChannel(ch)),
    [favoriteUrls]
  );

  useEffect(() => {
    const onPlaybackState = (ev: Event) => {
      const detail = (ev as CustomEvent<{ channelId?: string; paused?: boolean }>).detail;
      if (!detail?.channelId || typeof detail.paused !== "boolean") return;
      setMediaPlaybackState({ channelId: detail.channelId, paused: detail.paused });
    };
    window.addEventListener(MEDIA_PLAYBACK_STATE_EVENT, onPlaybackState);
    return () => window.removeEventListener(MEDIA_PLAYBACK_STATE_EVENT, onPlaybackState);
  }, []);

  const toggleMediaPlayback = useCallback(
    (ch: Channel, active: boolean, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!active) {
        onSelectEpisode(ch);
        return;
      }
      window.dispatchEvent(new CustomEvent(MEDIA_PLAYBACK_TOGGLE_EVENT, { detail: { channelId: ch.id } }));
    },
    [onSelectEpisode]
  );

  const openShow = useCallback((show: PodcastShowRow) => {
    setSelectedShow(show);
    setEpisodeQuery("");
  }, []);

  const backToShows = useCallback(() => {
    setSelectedShow(null);
    setEpisodes([]);
    setEpisodesErr(null);
  }, []);

  const removeShow = useCallback((collectionId: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setShows((cur) => cur.filter((s) => s.collectionId !== collectionId));
  }, []);

  const removeEpisode = useCallback((trackId: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEpisodes((cur) => cur.filter((ep) => ep.trackId !== trackId));
  }, []);

  return (
    <div className="podcast-root">
      <header className="podcast-header">
        <h2 className="podcast-title">Online podcasts</h2>
        <p className="podcast-sub">
          Free directory via{" "}
          <a href="https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/" target="_blank" rel="noreferrer">
            Apple Podcasts
          </a>
          .
        </p>
      </header>

      <div className="podcast-controls">
        {inEpisodeView ? (
          <div className="podcast-show-nav">
            <button type="button" className="podcast-back-btn" onClick={backToShows}>
              ← All shows
            </button>
            <div className="podcast-show-nav-meta">
              <PodcastArtwork url={selectedShow.artworkUrl} label={selectedShow.collectionName} />
              <div className="podcast-show-nav-text">
                <span className="podcast-show-nav-title">{selectedShow.collectionName}</span>
                <span className="podcast-show-nav-author">{selectedShow.artistName}</span>
              </div>
            </div>
          </div>
        ) : podcastListTab !== "favorites" ? (
          <div className="podcast-filter-grid">
            <div className="podcast-filter-row">
              <div className="podcast-filter-head">
                <label className="podcast-filter-label" htmlFor="podcast-country-select">
                  Country
                </label>
                <button
                  type="button"
                  className="podcast-refresh-btn"
                  disabled={loadingShows}
                  title="Reload podcast shows"
                  onClick={() => setShowsRefreshTick((n) => n + 1)}
                >
                  Refresh list
                </button>
              </div>
              <select
                id="podcast-country-select"
                className="podcast-filter-select"
                value={countryCode}
                onChange={(e) => onPodcastCountryChange(e.target.value)}
              >
                {PODCAST_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="podcast-filter-row">
              <label className="podcast-filter-label" htmlFor="podcast-genre-select">
                Genre
              </label>
              <select
                id="podcast-genre-select"
                className="podcast-filter-select"
                value={String(podcastGenreId)}
                onChange={(e) => onPodcastGenreChange(Number(e.target.value))}
              >
                {PODCAST_GENRES.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : null}
        {podcastListTab !== "favorites" ? (
          <div className="podcast-search-row">
            <input
              className="podcast-search"
              type="search"
              placeholder={inEpisodeView ? "Search episodes in this show…" : "Search shows in this country…"}
              value={inEpisodeView ? episodeQuery : query}
              onChange={(e) => (inEpisodeView ? setEpisodeQuery(e.target.value) : setQuery(e.target.value))}
              autoComplete="off"
              spellCheck={false}
            />
            {(inEpisodeView ? episodeQuery : query).trim() ? (
              <button
                type="button"
                className="podcast-clear-search"
                onClick={() => (inEpisodeView ? setEpisodeQuery("") : setQuery(""))}
                title="Clear search"
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : null}
        <div className={`podcast-status${showsErr || episodesErr ? " podcast-status--err" : ""}`}>
          {inEpisodeView
            ? episodesErr
              ? episodesErr
              : loadingEpisodes
                ? `Loading episodes for ${selectedShow.collectionName}…`
                : podcastListTab === "favorites"
                  ? `${filtered.length.toLocaleString()} favorite episode${filtered.length === 1 ? "" : "s"} in this show`
                  : `${filtered.length.toLocaleString()} episode${filtered.length === 1 ? "" : "s"}${episodeQuery.trim() ? " (filtered)" : ""}`
            : showsErr
              ? showsErr
              : loadingShows
                ? `Loading ${genreName} podcasts in ${PODCAST_COUNTRIES.find((c) => c.code === countryCode)?.name ?? countryCode}…`
                : podcastListTab === "favorites"
                  ? "Open a show, then use Favorites for starred episodes in that podcast."
                  : `${filtered.length.toLocaleString()} show${filtered.length === 1 ? "" : "s"}${query.trim() ? " (filtered)" : ""}`}
        </div>
      </div>

      <div className="podcast-list-tabs" role="tablist" aria-label="Podcast list">
        <button
          type="button"
          role="tab"
          aria-selected={podcastListTab === "all"}
          className={`podcast-list-tab${podcastListTab === "all" ? " podcast-list-tab--active" : ""}`}
          onClick={() => setPodcastListTab("all")}
        >
          {inEpisodeView ? "All episodes" : "All shows"}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={podcastListTab === "favorites"}
          className={`podcast-list-tab${podcastListTab === "favorites" ? " podcast-list-tab--active" : ""}`}
          onClick={() => {
            setQuery("");
            setEpisodeQuery("");
            setPodcastListTab("favorites");
          }}
        >
          Favorites{favoritesInView > 0 ? ` (${favoritesInView})` : ""}
        </button>
      </div>

      <div className="podcast-scroll" ref={scrollRef} onScroll={onScroll}>
        {inEpisodeView ? (
          loadingEpisodes && episodes.length === 0 ? (
            <div className="podcast-empty">Loading episodes…</div>
          ) : episodesErr && !loadingEpisodes ? (
            <div className="podcast-empty podcast-empty--err">{episodesErr}</div>
          ) : !loadingEpisodes && filtered.length === 0 ? (
            <div className="podcast-empty">
              {podcastListTab === "favorites"
                ? "No favorite episodes in this show yet. Star an episode to save it here."
                : episodeQuery.trim()
                  ? "No episodes match your search."
                  : "No episodes returned for this show."}
            </div>
          ) : (
            <div className="podcast-scroll-inner" style={{ height: totalH }}>
              {(filtered as typeof filteredEpisodes).slice(start, end).map(({ ep, ch }, i) => {
                const index = start + i;
                const top = index * rowH;
                const fav = isFavorite(ch);
                const leftOn = ch.id === activeLeftId;
                const rightOn = splitView && ch.id === activeRightId;
                const active = leftOn || rightOn;
                const playback = mediaPlaybackState?.channelId === ch.id ? mediaPlaybackState : null;
                const isPlaying = active && playback?.paused !== true;
                const isPaused = active && playback?.paused === true;
                const rowClass =
                  active ? `podcast-row podcast-row--episode active${leftOn ? " active--left" : ""}${rightOn ? " active--right" : ""}` : "podcast-row podcast-row--episode";
                const duration = formatPodcastDuration(ep.trackTimeMillis);
                const date = formatPodcastDate(ep.releaseDate);
                return (
                  <div key={ep.trackId} className={rowClass} style={{ transform: `translateY(${top}px)` }}>
                    <button type="button" className="podcast-row-hit" onClick={() => onSelectEpisode(ch)}>
                      <PodcastArtwork url={ep.artworkUrl || selectedShow?.artworkUrl} label={ep.trackName} />
                      <span className="podcast-meta">
                        <span className="podcast-name">{ch.name}</span>
                        <span className="podcast-tags">
                          {[date, duration].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </button>
                    <div className="podcast-row-actions" aria-label="Playback">
                      <button
                        type="button"
                        className={`podcast-play-btn${isPaused ? " podcast-play-btn--paused" : ""}`}
                        title={isPlaying ? "Pause" : isPaused ? "Resume" : "Play"}
                        aria-label={isPlaying ? `Pause ${ch.name}` : isPaused ? `Resume ${ch.name}` : `Play ${ch.name}`}
                        onClick={(e) => toggleMediaPlayback(ch, active, e)}
                      >
                        {isPlaying ? "Ⅱ" : "▶"}
                      </button>
                      {podcastListTab !== "favorites" ? (
                        <button
                          type="button"
                          className="podcast-remove-btn"
                          title="Remove from list"
                          aria-label={`Remove ${ch.name}`}
                          onClick={(e) => removeEpisode(ep.trackId, e)}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className={`podcast-fav-btn${fav ? " podcast-fav-btn--on" : ""}`}
                      onClick={(e) => toggleFavorite(ch, e)}
                      title={fav ? "Remove from favorites" : "Add to favorites"}
                      aria-label={fav ? `Remove ${ch.name} from favorites` : `Add ${ch.name} to favorites`}
                      aria-pressed={fav}
                    >
                      ★
                    </button>
                  </div>
                );
              })}
            </div>
          )
        ) : loadingShows && shows.length === 0 ? (
          <div className="podcast-empty">Loading shows…</div>
        ) : showsErr && !loadingShows ? (
          <div className="podcast-empty podcast-empty--err">{showsErr}</div>
        ) : !loadingShows && filtered.length === 0 ? (
          <div className="podcast-empty">
            {podcastListTab === "favorites"
              ? "Open a show, then switch to Favorites to see starred episodes for that podcast."
              : query.trim()
                ? "No shows match your search."
                : "No shows returned for this country and genre. Try another filter."}
          </div>
        ) : (
          <div className="podcast-scroll-inner" style={{ height: totalH }}>
            {(filtered as PodcastShowRow[]).slice(start, end).map((s, i) => {
              const index = start + i;
              const top = index * rowH;
              const rowClass = "podcast-row";
              const subtitle = [s.artistName, s.primaryGenreName].filter(Boolean).join(" · ");
              return (
                <div key={s.collectionId} className={rowClass} style={{ transform: `translateY(${top}px)` }}>
                  <button type="button" className="podcast-row-hit" onClick={() => openShow(s)}>
                    <PodcastArtwork url={s.artworkUrl} label={s.collectionName} />
                    <span className="podcast-meta">
                      <span className="podcast-name">{s.collectionName}</span>
                      {subtitle ? <span className="podcast-tags">{subtitle}</span> : null}
                    </span>
                  </button>
                  <div className="podcast-row-actions" aria-label="Show">
                    <button
                      type="button"
                      className="podcast-open-btn"
                      title="Open episodes"
                      aria-label={`Open episodes for ${s.collectionName}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openShow(s);
                      }}
                    >
                      ›
                    </button>
                    <button
                      type="button"
                      className="podcast-remove-btn"
                      title="Remove from list"
                      aria-label={`Remove ${s.collectionName}`}
                      onClick={(e) => removeShow(s.collectionId, e)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
