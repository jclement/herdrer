import { useEffect, useState } from "react";

/**
 * iOS Safari does not resize the layout viewport when the software keyboard
 * opens — it shrinks the *visual* viewport and offsets the layout viewport, so a
 * `position: fixed; bottom: 0` bar vanishes under the keyboard. WebKit has no
 * VirtualKeyboard API, so positioning against `window.visualViewport` is the
 * platform's answer rather than a stopgap.
 *
 * The bar is placed at `top: height + offsetTop` and pulled up by
 * `translateY(-100%)`. It is visibly a little wrong during the keyboard's
 * open/close animation; a transition makes that worse, so there isn't one.
 */
export interface ViewportMetrics {
  height: number;
  offsetTop: number;
  /** True once the visual viewport is meaningfully shorter than the window. */
  keyboardOpen: boolean;
}

function read(): ViewportMetrics {
  const vv = window.visualViewport;
  if (!vv) {
    return { height: window.innerHeight, offsetTop: 0, keyboardOpen: false };
  }
  return {
    height: vv.height,
    offsetTop: vv.offsetTop,
    keyboardOpen: window.innerHeight - vv.height > 120,
  };
}

export function useVisualViewport(): ViewportMetrics {
  const [metrics, setMetrics] = useState<ViewportMetrics>(() =>
    typeof window === "undefined"
      ? { height: 0, offsetTop: 0, keyboardOpen: false }
      : { height: window.innerHeight, offsetTop: 0, keyboardOpen: false },
  );

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setMetrics(read()));
    };
    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("orientationchange", update);
    return () => {
      cancelAnimationFrame(frame);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return metrics;
}

/** Style for an element that must sit on top of the keyboard, not under it. */
export function keyboardAnchoredStyle(m: ViewportMetrics): React.CSSProperties {
  return {
    position: "fixed",
    left: 0,
    right: 0,
    top: `${m.height + m.offsetTop}px`,
    transform: "translateY(-100%)",
  };
}
