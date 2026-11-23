import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LexiconsTab from './LexiconsTab';
import { currentLexiconTerms, useLexiconStore } from '../../store/lexiconStore';

beforeEach(() => {
  useLexiconStore.setState({ lexicons: [] });
});

describe('LexiconsTab', () => {
  it('affiche l’état vide tant qu’aucun lexique n’existe', () => {
    render(<LexiconsTab />);
    expect(screen.getByRole('heading', { name: 'No vocabulary list' })).toBeInTheDocument();
  });

  it('crée un lexique, le renomme et y saisit des termes au clavier', async () => {
    const user = userEvent.setup();
    render(<LexiconsTab />);

    await user.click(screen.getByRole('button', { name: 'New' }));
    // Le nom est sélectionné à la création : la saisie le remplace.
    const name = screen.getByLabelText('Name');
    expect(name).toHaveFocus();
    await user.keyboard('Travail');

    await user.type(screen.getByRole('textbox', { name: 'Correct spelling' }), 'Zentra');
    await user.type(screen.getByRole('textbox', { name: 'Misheard forms of “Zentra”' }), 'sentra, sen tra{Enter}');
    // Entrée sur la dernière ligne : une nouvelle ligne, prête à la saisie.
    const terms = screen.getAllByRole('textbox', { name: 'Correct spelling' });
    expect(terms).toHaveLength(2);
    expect(terms[1]).toHaveFocus();
    await user.keyboard('ACME');

    expect(screen.getByRole('button', { name: /Travail/ })).toHaveTextContent('Terms: 2');
    expect(currentLexiconTerms()).toEqual([
      { term: 'Zentra', variants: ['sentra', 'sen tra'] },
      { term: 'ACME', variants: [] },
    ]);
  });

  it('désactive un lexique depuis la liste', async () => {
    const user = userEvent.setup();
    const id = useLexiconStore.getState().addLexicon('Travail');
    const entry = useLexiconStore.getState().lexicons[0].entries[0].id;
    useLexiconStore.getState().updateEntry(id, entry, { term: 'Zentra' });
    render(<LexiconsTab />);

    await user.click(screen.getByRole('checkbox', { name: 'Use “Travail”' }));
    expect(currentLexiconTerms()).toEqual([]);
    expect(screen.getByRole('checkbox', { name: 'Use for transcriptions and summaries' })).not.toBeChecked();
  });

  it('supprime un lexique après confirmation', async () => {
    const user = userEvent.setup();
    useLexiconStore.getState().addLexicon('Travail');
    render(<LexiconsTab />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('The list “Travail” and its terms will be deleted.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(useLexiconStore.getState().lexicons).toEqual([]);
    expect(screen.getByRole('heading', { name: 'No vocabulary list' })).toBeInTheDocument();
  });
});
