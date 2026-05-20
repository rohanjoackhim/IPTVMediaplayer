export type PopoverRect = { width: number; height: number };

export type PopoverPosition = {
  top: number;
  left: number;
  maxHeight: number;
};

export type PopoverAlign = "start" | "end" | "center";

/**
 * Fixed viewport position for a popover anchored to a trigger, flipping to stay on-screen.
 */
export function measureAnchoredPopoverPosition(
  anchor: DOMRect,
  panel: PopoverRect,
  opts?: { gap?: number; padding?: number; align?: PopoverAlign; preferAbove?: boolean }
): PopoverPosition {
  const gap = opts?.gap ?? 6;
  const pad = opts?.padding ?? 8;
  const align = opts?.align ?? "start";
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceBelow = vh - anchor.bottom - gap - pad;
  const spaceAbove = anchor.top - gap - pad;
  const preferAbove =
    opts?.preferAbove === true ||
    (opts?.preferAbove !== false && spaceBelow < panel.height && spaceAbove > spaceBelow);

  let top = preferAbove ? anchor.top - gap - panel.height : anchor.bottom + gap;
  let left: number;
  if (align === "end") {
    left = anchor.right - panel.width;
  } else if (align === "center") {
    left = anchor.left + (anchor.width - panel.width) / 2;
  } else {
    left = anchor.left;
  }

  left = Math.max(pad, Math.min(left, vw - panel.width - pad));
  top = Math.max(pad, Math.min(top, vh - panel.height - pad));

  const maxHeight = preferAbove
    ? Math.max(96, anchor.top - gap - pad)
    : Math.max(96, vh - top - pad);

  return { top, left, maxHeight };
}
