import { useState } from 'react';
import { applyTheme, readTheme, saveTheme, THEME_HINT, THEME_LABEL, THEMES, type ThemeChoice } from '../lib/theme';

/** Light, Dark, or Device (follow the phone or computer). Remembered on this device. */
export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const pick = (c: ThemeChoice) => {
    setChoice(c);
    saveTheme(c);
    applyTheme(c);
  };
  return (
    <div role="group" aria-label="Colour theme" className="inline-flex rounded-lg border border-line bg-card p-0.5 text-sm">
      {THEMES.map((c) => (
        <button
          key={c}
          type="button"
          title={THEME_HINT[c]}
          aria-pressed={choice === c}
          onClick={() => pick(c)}
          className={`min-h-9 rounded-md px-3 font-medium ${choice === c ? 'bg-brand text-on-brand' : 'text-ink hover:bg-page'}`}
        >
          {THEME_LABEL[c]}
        </button>
      ))}
    </div>
  );
}