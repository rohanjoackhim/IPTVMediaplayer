import { describe, expect, it } from "vitest";
import {
  formatPodcastDate,
  formatPodcastDuration,
  podcastEpisodeToChannel,
  PODCAST_GENRES,
} from "./podcastApi";

describe("podcastApi", () => {
  it("maps episodes to podcast channels", () => {
    const ch = podcastEpisodeToChannel(
      {
        trackId: 99,
        trackName: "Episode One",
        collectionId: 42,
        collectionName: "Test Show",
        episodeUrl: "https://cdn.example.com/ep1.mp3",
      },
      {
        collectionId: 42,
        collectionName: "Test Show",
        artistName: "Host",
        artworkUrl: "https://cdn.example.com/art.jpg",
      }
    );
    expect(ch.id).toBe("podcast-42-99");
    expect(ch.name).toBe("Episode One");
    expect(ch.url).toBe("https://cdn.example.com/ep1.mp3");
    expect(ch.group).toBe("Test Show");
    expect(ch.logo).toBe("https://cdn.example.com/art.jpg");
  });

  it("formats duration and dates", () => {
    expect(formatPodcastDuration(125_000)).toBe("2:05");
    expect(formatPodcastDuration(3_661_000)).toBe("1:01:01");
    expect(formatPodcastDate("2024-06-15T12:00:00Z")).toMatch(/2024/);
  });

  it("includes common podcast genres", () => {
    expect(PODCAST_GENRES.some((g) => g.name === "News")).toBe(true);
    expect(PODCAST_GENRES.some((g) => g.id === 0)).toBe(true);
  });
});
