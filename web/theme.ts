import { useLayoutEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const themeKey = 'deeppi.theme';

function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(themeKey);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Browser storage can be disabled. */ }
  return 'system';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.body.toggleAttribute('data-ds-dark-theme', dark);
      document.body.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    try { localStorage.setItem(themeKey, theme); } catch { /* Browser storage can be disabled. */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme] as const;
}
