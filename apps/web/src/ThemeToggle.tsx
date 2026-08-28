import { useTheme } from "./ThemeProvider.js";

/** Sits to the right of the location chip in FilterChipRow (§8.1). */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      style={{
        border: "1px solid var(--border)",
        borderRadius: "999px",
        background: "var(--chip-bg)",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        lineHeight: 1.3,
        padding: "0.05rem 0.5rem",
      }}
    >
      {isDark ? "☀ light" : "☾ dark"}
    </button>
  );
}
