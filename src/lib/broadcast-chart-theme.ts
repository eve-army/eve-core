/**
 * Hex theme aligned with CSS tokens in globals.css (--eve-*).
 * ECharts cannot read CSS variables reliably in all option fields; keep chart colors here in sync.
 */
export const broadcastChartTheme = {
  accentA: "#00f5ff",
  accentB: "#ff2d95",
  text: "#f1f5f9",
  textMuted: "#94a3b8",
  axisLabel: "#64748b",
  splitLine: "rgba(148,163,184,0.16)",
  splitAreaLo: "rgba(22,14,40,0.62)",
  splitAreaHi: "rgba(32,20,56,0.28)",
  tooltipBg: "rgba(10,6,20,0.94)",
  tooltipBorder: "rgba(0,245,255,0.4)",
  labelHalo: "rgba(3,3,8,0.96)",
  activeShadow: "rgba(0,245,255,0.55)",
  emphasisShadow: "rgba(255,45,149,0.4)",
  changeNew: "#00f5ff",
  changeUp: "#3cff9a",
  changeDown: "#fbbf24",
} as const;
