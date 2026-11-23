import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { useLocaleStore } from '../i18n';

// Interface en anglais par défaut : les assertions sur les libellés restent stables.
beforeEach(() => {
  useLocaleStore.setState({ preference: 'en', locale: 'en' });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});
