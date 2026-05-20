import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Channel } from "../types";
import { favoriteKeyForChannel } from "../utils/favoritesStorage";
import {
  fetchRadioCountries,
  fetchRadioStationsByCountry,
  radioStationToChannel,
  type RadioBrowserCountryRow,
  type RadioBrowserStationRow,
} from "../utils/radioBrowserApi";
import { loadUiSession, saveUiSession, type RadioListTabPersisted } from "../utils/uiSessionStorage";
import "./RadioPanel.css";

const ROW_H = 42;
const OVERSCAN = 12;
const MEDIA_PLAYBACK_TOGGLE_EVENT = "iptv-media-playback-toggle";
const MEDIA_PLAYBACK_STATE_EVENT = "iptv-media-playback-state";

export interface RadioPanelProps {
  onSelectStation: (c: Channel) => void;
  activeLeftId: string | null;
  activeRightId: string | null;
  splitView: boolean;
  favoriteUrls: Set<string>;
  onToggleFavoriteChannel: (c: Channel) => void;
  radioCountry: string;
  onRadioCountryChange: (countryName: string) => void;
}

function RadioStationLogo({ station }: { station: RadioBrowserStationRow }) {
  const [failed, setFailed] = useState(false);
  const fav = station.favicon?.trim();
  if (fav && /^https?:\/\//i.test(fav) && !failed) {
    return (
      <img
        className="radio-logo"
        src={fav}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="radio-logo radio-logo--placeholder" aria-hidden>
      ♪
    </span>
  );
}

export function RadioPanel({
  onSelectStation,
  activeLeftId,
  activeRightId,
  splitView,
  favoriteUrls,
  onToggleFavoriteChannel,
  radioCountry,
  onRadioCountryChange,
}: RadioPanelProps) {
  const [countries, setCountries] = useState<RadioBrowserCountryRow[]>([]);
  const [stations, setStations] = useState<RadioBrowserStationRow[]>([]);
  const [radioListTab, setRadioListTab] = useState<RadioListTabPersisted>(() => loadUiSession().radioListTab);
  const [query, setQuery] = useState("");
  const [loadingCountries, setLoadingCountries] = useState(true);
  const [loadingStations, setLoadingStations] = useState(false);
  const [countriesErr, setCountriesErr] = useState<string | null>(null);
  const [stationsErr, setStationsErr] = useState<string | null>(null);
  const [stationsRefreshTick, setStationsRefreshTick] = useState(0);
  const [mediaPlaybackState, setMediaPlaybackState] = useState<{ channelId: string; paused: boolean } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoadingCountries(true);
    setCountriesErr(null);
    void fetchRadioCountries(ac.signal)
      .then((list) => {
        setCountries(list);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setCountriesErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoadingCountries(false));
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (!countries.length) return;
    const ok = radioCountry.trim() && countries.some((c) => c.name === radioCountry);
    if (!ok && countries[0]?.name) {
      onRadioCountryChange(countries[0].name);
    }
  }, [countries, radioCountry, onRadioCountryChange]);

  useEffect(() => {
    const name = radioCountry.trim();
    if (!name) return;
    const ac = new AbortController();
    setStations([]);
    setLoadingStations(true);
    setStationsErr(null);
    void fetchRadioStationsByCountry(name, ac.signal)
      .then(setStations)
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setStationsErr(e instanceof Error ? e.message : String(e));
        setStations([]);
      })
      .finally(() => setLoadingStations(false));
    return () => ac.abort();
  }, [radioCountry, stationsRefreshTick]);

  useEffect(() => {
    saveUiSession({ radioListTab });
  }, [radioListTab]);

  const favoritesInCountry = useMemo(
    () => stations.filter((s) => favoriteUrls.has(favoriteKeyForChannel(radioStationToChannel(s)))).length,
    [stations, favoriteUrls]
  );

  const tabFiltered = useMemo(() => {
    if (radioListTab === "favorites") {
      return stations.filter((s) => favoriteUrls.has(favoriteKeyForChannel(radioStationToChannel(s))));
    }
    return stations;
  }, [stations, radioListTab, favoriteUrls]);

  const filtered = useMemo(() => {
    if (radioListTab === "favorites") return tabFiltered;
    const q = query.trim().toLowerCase();
    if (!q) return tabFiltered;
    return tabFiltered.filter((s) => {
      const name = (s.name || "").toLowerCase();
      const tags = (s.tags || "").toLowerCase();
      return name.includes(q) || tags.includes(q);
    });
  }, [tabFiltered, query, radioListTab]);

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
  }, [radioCountry, query, stations.length, radioListTab, stationsRefreshTick]);

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
        onSelectStation(ch);
        return;
      }
      window.dispatchEvent(new CustomEvent(MEDIA_PLAYBACK_TOGGLE_EVENT, { detail: { channelId: ch.id } }));
    },
    [onSelectStation]
  );

  const removeStation = useCallback((stationuuid: string, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setStations((cur) => cur.filter((s) => s.stationuuid !== stationuuid));
  }, []);

  const countryOptions = useMemo(
    () =>
      countries.map((c) => (
        <option key={c.name} value={c.name}>
          {c.name} ({c.stationcount.toLocaleString()})
        </option>
      )),
    [countries]
  );

  return (
    <div className="radio-root">
      <header className="radio-header">
        <h2 className="radio-title">Online radio</h2>
        <p className="radio-sub">
          Live stations via{" "}
          <a href="https://www.radio-browser.info/" target="_blank" rel="noreferrer">
            Radio Browser
          </a>
          .
        </p>
      </header>

      {radioListTab !== "favorites" ? (
      <div className="radio-controls">
        <div className="radio-filter-row">
          <div className="radio-filter-head">
            <label className="radio-filter-label" htmlFor="radio-country-select">
              Country
            </label>
            <button
              type="button"
              className="radio-refresh-btn"
              disabled={loadingStations || !radioCountry.trim() || loadingCountries}
              title="Reload stations for this country"
              onClick={() => setStationsRefreshTick((n) => n + 1)}
            >
              Refresh list
            </button>
          </div>
          <select
            id="radio-country-select"
            className="radio-filter-select"
            value={countries.some((c) => c.name === radioCountry) ? radioCountry : ""}
            disabled={loadingCountries || !countries.length}
            onChange={(e) => onRadioCountryChange(e.target.value)}
          >
            {loadingCountries ? (
              <option value="">Loading countries…</option>
            ) : countriesErr ? (
              <option value="">Could not load countries</option>
            ) : (
              countryOptions
            )}
          </select>
        </div>
        <div className="radio-search-row">
          <input
            className="radio-search"
            type="search"
            placeholder="Search stations in this country…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={!stations.length && !loadingStations}
          />
          {query.trim() ? (
            <button type="button" className="radio-clear-search" onClick={() => setQuery("")} title="Clear search">
              Clear
            </button>
          ) : null}
        </div>
        <div className={`radio-status${stationsErr || countriesErr ? " radio-status--err" : ""}`}>
          {countriesErr
            ? countriesErr
            : loadingCountries
              ? "Loading country list…"
              : loadingStations
                ? `Loading stations in ${radioCountry}…`
                : stationsErr
                  ? stationsErr
                  : `${filtered.length.toLocaleString()} station${filtered.length === 1 ? "" : "s"}${query.trim() ? " (filtered)" : ""}`}
        </div>
      </div>
      ) : (
        <div className="radio-controls radio-controls--favorites-only">
          <div className="radio-status">
            {`${filtered.length.toLocaleString()} favorite station${filtered.length === 1 ? "" : "s"} in ${radioCountry}`}
          </div>
        </div>
      )}

      <div className="radio-list-tabs" role="tablist" aria-label="Station list">
        <button
          type="button"
          role="tab"
          aria-selected={radioListTab === "all"}
          className={`radio-list-tab${radioListTab === "all" ? " radio-list-tab--active" : ""}`}
          onClick={() => setRadioListTab("all")}
        >
          All stations
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={radioListTab === "favorites"}
          className={`radio-list-tab${radioListTab === "favorites" ? " radio-list-tab--active" : ""}`}
          onClick={() => {
            setQuery("");
            setRadioListTab("favorites");
          }}
        >
          Favorites{favoritesInCountry > 0 ? ` (${favoritesInCountry})` : ""}
        </button>
      </div>

      <div className="radio-scroll" ref={scrollRef} onScroll={onScroll}>
        {loadingStations && stations.length === 0 ? (
          <div className="radio-empty">Loading stations…</div>
        ) : stationsErr && !loadingStations ? (
          <div className="radio-empty radio-empty--err">{stationsErr}</div>
        ) : !loadingStations && !stationsErr && filtered.length === 0 ? (
          <div className="radio-empty">
            {radioListTab === "favorites" ? (
              favoritesInCountry === 0 ? (
                favoriteUrls.size > 0 ? (
                  <>
                    You have <strong>{favoriteUrls.size}</strong> saved favorite{favoriteUrls.size === 1 ? "" : "s"}{" "}
                    in this app, but none are stations listed for <strong>{radioCountry}</strong>. Open{" "}
                    <strong>All stations</strong> and star some here, or switch country to match your TV/radio
                    favorites.
                  </>
                ) : (
                  <>
                    No favorites yet. Open <strong>All stations</strong> and click <strong>★</strong> on a row to add
                    it here (same favorites as Television).
                  </>
                )
              ) : query.trim() ? (
                <>No favorite stations match your search. Try clearing the search box.</>
              ) : (
                <>No favorite stations to show for this country.</>
              )
            ) : stations.length === 0 ? (
              "No stations returned for this country. Try another country from the list."
            ) : (
              "No stations match your search. Clear the search box to see all stations in this country."
            )}
          </div>
        ) : (
          <div className="radio-scroll-inner" style={{ height: totalH }}>
            {filtered.slice(start, end).map((s, i) => {
              const index = start + i;
              const top = index * ROW_H;
              const ch = radioStationToChannel(s);
              const fav = isFavorite(ch);
              const leftOn = ch.id === activeLeftId;
              const rightOn = splitView && ch.id === activeRightId;
              const active = leftOn || rightOn;
              const playback = mediaPlaybackState?.channelId === ch.id ? mediaPlaybackState : null;
              const isPlaying = active && playback?.paused !== true;
              const isPaused = active && playback?.paused === true;
              const rowClass =
                active
                  ? `radio-row active${leftOn ? " active--left" : ""}${rightOn ? " active--right" : ""}`
                  : "radio-row";
              return (
                <div key={s.stationuuid} className={rowClass} style={{ transform: `translateY(${top}px)` }}>
                  <button type="button" className="radio-row-hit" onClick={() => onSelectStation(ch)}>
                    <RadioStationLogo station={s} />
                    <span className="radio-meta">
                      <span className="radio-name">{ch.name}</span>
                      {s.tags?.trim() ? (
                        <span className="radio-tags">{s.tags.split(",").slice(0, 4).join(" · ")}</span>
                      ) : null}
                    </span>
                  </button>
                  <div className="radio-row-actions" aria-label="Playback">
                    <button
                      type="button"
                      className={`radio-play-btn${isPaused ? " radio-play-btn--paused" : ""}`}
                      title={isPlaying ? "Pause" : isPaused ? "Resume" : "Play"}
                      aria-label={isPlaying ? `Pause ${ch.name}` : isPaused ? `Resume ${ch.name}` : `Play ${ch.name}`}
                      onClick={(e) => toggleMediaPlayback(ch, active, e)}
                    >
                      {isPlaying ? "Ⅱ" : "▶"}
                    </button>
                    {radioListTab !== "favorites" ? (
                      <button
                        type="button"
                        className="radio-remove-btn"
                        title="Remove from list"
                        aria-label={`Remove ${ch.name}`}
                        onClick={(e) => removeStation(s.stationuuid, e)}
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className={`radio-fav-btn${fav ? " radio-fav-btn--on" : ""}`}
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
        )}
      </div>
    </div>
  );
}
