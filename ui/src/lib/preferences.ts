/** Per-user UI preferences (theme, language, onboarding). Stored locally; never leaves the device. */
const PREFIX = "moleculeforge.";

export function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // Storage can be unavailable (private mode); preferences then last for the session only.
  }
}
