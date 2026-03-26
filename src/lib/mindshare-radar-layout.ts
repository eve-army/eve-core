/** Must stay in sync with ECharts `polar` in TrendRadarChart. */
export const POLAR_CENTER_X = 0.5;
/** Vertically centered in the square chart (was 0.52 for taller rectangular layouts). */
export const POLAR_CENTER_Y = 0.5;
/**
 * Polar radius as a fraction of half the shorter chart side (ECharts `radius: "${…}%"`).
 * Tuned for the centered square chart so rings + labels stay readable.
 */
export const POLAR_RADIUS = 0.78;
/** Tighter polar for stream embeds — leaves canvas margin so long labels aren’t cut off at the rim. */
export const POLAR_RADIUS_STREAM = 0.62;

export function polarPixelLayout(
  width: number,
  height: number,
  radiusFraction: number = POLAR_RADIUS,
) {
  const halfMin = Math.min(width, height) / 2;
  const polarRadiusPx = radiusFraction * halfMin;
  return {
    cx: width * POLAR_CENTER_X,
    cy: height * POLAR_CENTER_Y,
    polarRadiusPx,
  };
}
