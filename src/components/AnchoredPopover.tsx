import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { measureAnchoredPopoverPosition, type PopoverAlign } from "../utils/popoverPosition";

export type AnchoredPopoverProps = {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  id?: string;
  role?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  align?: PopoverAlign;
  /** When true, open above the trigger if the chrome sits at the bottom of the viewport. */
  preferAbove?: boolean;
  panelRef?: RefObject<HTMLDivElement | null>;
};

export function AnchoredPopover({
  open,
  anchorRef,
  children,
  className,
  id,
  role,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  align = "start",
  preferAbove = true,
  panelRef: panelRefProp,
}: AnchoredPopoverProps) {
  const localPanelRef = useRef<HTMLDivElement>(null);
  const panelRef = panelRefProp ?? localPanelRef;
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    const update = () => {
      const ar = anchor.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      const width = pr.width > 0 ? pr.width : panel.offsetWidth || 160;
      const height = pr.height > 0 ? pr.height : panel.offsetHeight || 120;
      const pos = measureAnchoredPopoverPosition(
        ar,
        { width, height },
        { align, preferAbove }
      );
      setStyle({
        position: "fixed",
        top: pos.top,
        left: pos.left,
        maxHeight: pos.maxHeight,
        overflow: "auto",
        zIndex: 10000,
        visibility: "visible",
      });
    };

    update();
    const raf = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(panel);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      ro?.disconnect();
    };
  }, [open, anchorRef, panelRef, align, preferAbove, children]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef as Ref<HTMLDivElement>}
      id={id}
      role={role}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={className}
      style={style}
      data-iptv-anchored-popover=""
    >
      {children}
    </div>,
    document.body
  );
}
