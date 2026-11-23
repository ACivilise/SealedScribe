import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useThemeStore } from './themeStore';

// jsdom n'implémente pas matchMedia : on simule la préférence système.
function mockSystemDark(dark: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({ matches: dark }) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  document.documentElement.classList.remove('dark');
  mockSystemDark(false);
});

describe('themeStore', () => {
  it('applique le thème sombre explicite', () => {
    useThemeStore.getState().setTheme('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(useThemeStore.getState().isDarkMode).toBe(true);
  });

  it('retire la classe pour le thème clair', () => {
    document.documentElement.classList.add('dark');
    useThemeStore.getState().setTheme('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(useThemeStore.getState().isDarkMode).toBe(false);
  });

  it('suit la préférence du système en mode « system »', () => {
    mockSystemDark(true);
    useThemeStore.getState().setTheme('system');
    expect(document.documentElement).toHaveClass('dark');
    expect(useThemeStore.getState().isDarkMode).toBe(true);

    mockSystemDark(false);
    useThemeStore.getState().updateDarkMode();
    expect(document.documentElement).not.toHaveClass('dark');
    expect(useThemeStore.getState().isDarkMode).toBe(false);
  });
});
