import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ParticipantList } from './ParticipantList';
import { REMOTE_SPEAKER_BASE, SPEAKER_ME } from '../../utils/speakers';

const renderList = (onRename = vi.fn()) => {
  render(
    <ParticipantList
      labels={[SPEAKER_ME, REMOTE_SPEAKER_BASE + 1]}
      speakers={[{ label: REMOTE_SPEAKER_BASE + 1, name: 'Paul' }]}
      colorOf={() => 'text-foreground'}
      onRename={onRename}
    />
  );
  return onRename;
};

describe('ParticipantList', () => {
  it('affiche le nom saisi ou le nom par défaut', () => {
    renderList();
    expect(screen.getByRole('button', { name: 'Rename Me' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename Paul' })).toBeInTheDocument();
  });

  it('enregistre le nouveau nom avec Entrée', () => {
    const onRename = renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Me' }));
    const input = screen.getByLabelText('Rename Me');
    fireEvent.change(input, { target: { value: '  Alex  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith(SPEAKER_ME, 'Alex');
  });

  it('part du nom saisi et annule avec Échap', () => {
    const onRename = renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Paul' }));
    const input = screen.getByLabelText('Rename Paul') as HTMLInputElement;
    expect(input.value).toBe('Paul');
    fireEvent.change(input, { target: { value: 'Pierre' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Rename Paul' })).toBeInTheDocument();
  });
});
