import "./AudioLibraryPlaybackControls.css";

export interface AudioLibraryPlaybackControlsProps {
  shuffle: boolean;
  continuous: boolean;
  onShuffleChange: (v: boolean) => void;
  onContinuousChange: (v: boolean) => void;
  onClearAll?: () => void;
  clearDisabled?: boolean;
  showLabel?: boolean;
}

export function AudioLibraryPlaybackControls({
  shuffle,
  continuous,
  onShuffleChange,
  onContinuousChange,
  onClearAll,
  clearDisabled = false,
  showLabel = false,
}: AudioLibraryPlaybackControlsProps) {
  return (
    <div className="audio-playback-controls" role="group" aria-label="Library playback options">
      {showLabel ? <span className="audio-playback-controls-label">Audio</span> : null}
      <button
        type="button"
        className={`audio-playback-icon-btn${shuffle ? " audio-playback-icon-btn--on" : ""}`}
        aria-pressed={shuffle}
        aria-label="Shuffle"
        title="When continuous play is on, pick a random track after each song"
        onClick={() => onShuffleChange(!shuffle)}
      >
        <span className="audio-playback-icon-glyph" aria-hidden>
          ⇄
        </span>
      </button>
      <button
        type="button"
        className={`audio-playback-icon-btn${continuous ? " audio-playback-icon-btn--on" : ""}`}
        aria-pressed={continuous}
        aria-label="Continuous play"
        title="When a library track ends, start the next (or a random one if shuffle is on)"
        onClick={() => onContinuousChange(!continuous)}
      >
        <span className="audio-playback-icon-glyph" aria-hidden>
          ⟳
        </span>
      </button>
      {onClearAll ? (
        <button
          type="button"
          className="audio-playback-icon-btn audio-playback-icon-btn--danger"
          aria-label="Clear all files from library"
          title="Remove every file from the audio library"
          disabled={clearDisabled}
          onClick={() => onClearAll()}
        >
          <span className="audio-playback-icon-glyph" aria-hidden>
            ⌫
          </span>
        </button>
      ) : null}
    </div>
  );
}
