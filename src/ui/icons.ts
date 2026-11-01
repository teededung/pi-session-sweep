import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseEnumString } from "../record-utils.ts";
import type { IconModePreference } from "../config-store.ts";

export type PickerIconMode = "nerd" | "fallback";

export interface PickerIcons {
  cursor: string;
  checkboxChecked: string;
  checkboxUnchecked: string;
  scrollUp: string;
  scrollDown: string;
  actionMove: string;
  actionPage: string;
  actionToggle: string;
  actionSelectAll: string;
  actionRefresh: string;
  actionDelete: string;
  actionCancel: string;
}

export interface ResolvedPickerIcons {
  mode: PickerIconMode;
  icons: PickerIcons;
}

export interface PickerIconDetectionContext {
  platform: string;
  env: Record<string, string | undefined>;
  pathExists: (path: string) => boolean;
  readTextFile: (path: string) => string | null;
}

const NERD_ICONS: PickerIcons = {
  cursor: "",
  checkboxChecked: "",
  checkboxUnchecked: "",
  scrollUp: "",
  scrollDown: "",
  actionMove: "󰆾",
  actionPage: "󰘖",
  actionToggle: "󰄱",
  actionSelectAll: "󰄬",
  actionRefresh: "󰑐",
  actionDelete: "󰆴",
  actionCancel: "󰜺",
};

const FALLBACK_ICONS: PickerIcons = {
  cursor: "›",
  checkboxChecked: "☑",
  checkboxUnchecked: "☐",
  scrollUp: "↑",
  scrollDown: "↓",
  actionMove: "↕",
  actionPage: "⇵",
  actionToggle: "☑",
  actionSelectAll: "☑",
  actionRefresh: "↻",
  actionDelete: "✖",
  actionCancel: "✖",
};

const KNOWN_NERD_TERM_PROGRAM_HINTS = [
  "wezterm",
  "ghostty",
  "kitty",
  "iterm",
  "warpterminal",
  "warp",
  "hyper",
  "alacritty",
  "konsole",
] as const;

const KNOWN_NERD_TERM_HINTS = ["xterm-kitty", "wezterm", "ghostty", "alacritty", "konsole"] as const;

const FONT_HINT_ENV_KEYS = [
  "PI_SESSION_SWEEP_FONT_FAMILY",
  "PI_FONT_FAMILY",
  "TERM_PROGRAM_FONT",
  "KITTY_FONT_FAMILY",
  "WEZTERM_FONT",
  "WT_PROFILE_FONT_FACE",
] as const;

const ICON_MODE_VALUES = ["auto", "nerd", "fallback"] as const;

function createDefaultContext(): PickerIconDetectionContext {
  return {
    platform: process.platform,
    env: process.env,
    pathExists: (path) => existsSync(path),
    readTextFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

function parseEnvBoolean(value: string | undefined): boolean | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return null;
}

function parseMode(value: string | undefined): IconModePreference | null {
  return parseEnumString<IconModePreference, null>(value, ICON_MODE_VALUES, null);
}

function resolvePreference(
  configPreference: IconModePreference,
  env: Record<string, string | undefined>,
): IconModePreference {
  const envMode = parseMode(env.PI_SESSION_SWEEP_ICON_MODE);
  if (envMode) {
    return envMode;
  }

  const envBool = parseEnvBoolean(env.PI_SESSION_SWEEP_NERD_FONT ?? env.PI_NERD_FONT);
  if (envBool !== null) {
    return envBool ? "nerd" : "fallback";
  }

  return configPreference;
}

function isNerdFontFace(fontFace: string | null): boolean {
  return typeof fontFace === "string" && /nerd/i.test(fontFace);
}

function detectFontHintFromEnv(env: Record<string, string | undefined>): boolean {
  for (const key of FONT_HINT_ENV_KEYS) {
    if (isNerdFontFace(env[key] ?? null)) {
      return true;
    }
  }

  return false;
}

function detectKnownTerminalHint(env: Record<string, string | undefined>): boolean {
  if (env.GHOSTTY_RESOURCES_DIR || env.WEZTERM_EXECUTABLE || env.WEZTERM_PANE || env.KITTY_WINDOW_ID) {
    return true;
  }

  const termProgram = (env.TERM_PROGRAM ?? "").trim().toLowerCase();
  if (KNOWN_NERD_TERM_PROGRAM_HINTS.some((hint) => termProgram.includes(hint))) {
    return true;
  }

  const term = (env.TERM ?? "").trim().toLowerCase();
  return KNOWN_NERD_TERM_HINTS.some((hint) => term.includes(hint));
}

function resolveAutoMode(context: PickerIconDetectionContext): PickerIconMode {
  if (detectFontHintFromEnv(context.env) || detectKnownTerminalHint(context.env)) {
    return "nerd";
  }

  return "fallback";
}

function iconsForMode(mode: PickerIconMode): PickerIcons {
  return mode === "nerd" ? NERD_ICONS : FALLBACK_ICONS;
}

export function resolvePickerIconsForContext(
  configPreference: IconModePreference,
  context: PickerIconDetectionContext,
): ResolvedPickerIcons {
  const preference = resolvePreference(configPreference, context.env);
  const mode =
    preference === "auto"
      ? resolveAutoMode(context)
      : preference === "nerd"
        ? "nerd"
        : "fallback";

  return {
    mode,
    icons: iconsForMode(mode),
  };
}

export function resolvePickerIcons(configPreference: IconModePreference): ResolvedPickerIcons {
  return resolvePickerIconsForContext(configPreference, createDefaultContext());
}
