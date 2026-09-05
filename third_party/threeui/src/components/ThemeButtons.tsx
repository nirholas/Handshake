import { MoonIcon, SunIcon, SystemIcon } from "./icons";
import { THEME_PALETTE_LABELS, type ThemeMode, type ThemePalette } from "../theme";

type ThemeButtonsProps = {
  compact?: boolean;
  mode: ThemeMode;
  palette: ThemePalette;
  onChange: (mode: ThemeMode) => void;
};

export function ThemeButtons({ compact = false, mode, palette, onChange }: ThemeButtonsProps) {
  const paletteLabel = THEME_PALETTE_LABELS[palette];

  return (
    <div className={`theme-buttons${compact ? " compact" : ""}`} role="group" aria-label="Appearance">
      <button
        className={`theme-button${mode === "light" ? " active" : ""}`}
        type="button"
        aria-label={mode === "light" ? `Light mode, ${paletteLabel}. Click to cycle palette` : "Use light mode"}
        aria-pressed={mode === "light"}
        title={mode === "light" ? `Light · ${paletteLabel}` : "Light"}
        onClick={() => onChange("light")}
      >
        <SunIcon />
        <span>Light</span>
      </button>
      <button
        className={`theme-button${mode === "dark" ? " active" : ""}`}
        type="button"
        aria-label={mode === "dark" ? `Dark mode, ${paletteLabel}. Click to cycle palette` : "Use dark mode"}
        aria-pressed={mode === "dark"}
        title={mode === "dark" ? `Dark · ${paletteLabel}` : "Dark"}
        onClick={() => onChange("dark")}
      >
        <MoonIcon />
        <span>Dark</span>
      </button>
      <button
        className={`theme-button${mode === "system" ? " active" : ""}`}
        type="button"
        aria-label="Follow system appearance"
        aria-pressed={mode === "system"}
        title="System"
        onClick={() => onChange("system")}
      >
        <SystemIcon />
        <span>System</span>
      </button>
    </div>
  );
}

export type { ThemeMode, ThemePalette };
