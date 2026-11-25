/**
 * The chat panel's own text zoom, kept apart from VS Code's window zoom.
 *
 * Free of `vscode` so `test/zoom.test.js` can drive it. The level is a factor
 * on the panel's base font size — every size in `chat.css` is in `em` from
 * that one rule, so scaling it scales the text in proportion. Spacing and
 * control heights are in px and stay put, deliberately: CSS `zoom` would scale
 * those too, but it also changes what `measureDock` reads.
 */

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1;

/** A stored level made safe: anything unreadable is the default. */
export function clampZoom(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return ZOOM_DEFAULT;
  return round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n)));
}

/**
 * One step in or out. Rounded to a tenth, because repeated float steps
 * otherwise land on 1.2000000000000002 and that is what the settings JSON
 * would end up holding.
 */
export function stepZoom(current: unknown, direction: "in" | "out" | "reset"): number {
  if (direction === "reset") return ZOOM_DEFAULT;
  const delta = direction === "in" ? ZOOM_STEP : -ZOOM_STEP;
  return clampZoom(clampZoom(current) + delta);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
