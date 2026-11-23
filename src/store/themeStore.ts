import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeStore {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  isDarkMode: boolean;
  updateDarkMode: () => void;
}

const applyTheme = (theme: ThemeMode) => {
  const html = document.documentElement;
  
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
      html.classList.add('dark');
    } else {
      html.classList.remove('dark');
    }
  } else if (theme === 'dark') {
    html.classList.add('dark');
  } else {
    html.classList.remove('dark');
  }
};

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      theme: 'system',
      isDarkMode: false,
      setTheme: (theme: ThemeMode) => {
        applyTheme(theme);
        set(() => {
          const newState = { theme };
          const isDark =
            theme === 'dark' ||
            (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
          return { ...newState, isDarkMode: isDark };
        });
      },
      updateDarkMode: () => {
        const theme = get().theme;
        applyTheme(theme);
        
        const isDark =
          theme === 'dark' ||
          (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        set({ isDarkMode: isDark });
      },
    }),
    {
      name: 'theme-store',
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.theme);
          const isDark =
            state.theme === 'dark' ||
            (state.theme === 'system' &&
              window.matchMedia('(prefers-color-scheme: dark)').matches);
          state.isDarkMode = isDark;
        }
      },
    }
  )
);
