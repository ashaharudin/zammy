import { useTheme } from "./ThemeProvider.js";

/**
 * Sits to the right of the location chip in FilterChipRow (§8.1).
 *
 * Icon-only, and the icon names the current mode rather than the action the
 * click performs: a moon while dark, a sun while light. `title` carries the
 * action for a mouse hover; `aria-label` still states it for a screen reader,
 * since a name like "moon" would describe the icon rather than the control.
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--border)",
        borderRadius: "999px",
        background: "var(--chip-bg)",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        lineHeight: 1.3,
        padding: "0.05rem 0.4rem",
      }}
    >
      {isDark ? "☾" : "☀"}
    </button>
  );
}
