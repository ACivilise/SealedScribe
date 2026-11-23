import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RecordingsTab from './RecordingsTab';
import { useMeetingStore, type MeetingSession } from '../../store/meetingStore';
import { EMPTY_TRANSCRIPTION, useTaskStore } from '../../store/taskStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));

const meeting = (id: string, title: string, tag?: string): MeetingSession => ({
  id,
  title,
  tag,
  language: 'fr-FR',
  duration: 60,
  recordedAt: new Date('2026-11-10T10:00:00Z'),
  status: 'completed',
  speakers: [],
});

const titles = () => screen.queryAllByRole('heading', { level: 3 }).map((h) => h.textContent);
const tagFilter = () => within(screen.getByRole('group', { name: 'Filter by tag' }));

beforeEach(() => {
  useMeetingStore.setState({
    meetings: [
      meeting('1', 'Comité projet', 'projet-x, Hebdo'),
      meeting('2', 'Point équipe', 'hebdo'),
      meeting('3', 'Entretien Alice', 'entretien'),
      meeting('4', 'Import sans étiquette'),
    ],
  });
});

const renderTab = () => render(<RecordingsTab openMeetingId={null} onOpenMeeting={vi.fn()} onEditPrompts={vi.fn()} />);

describe('RecordingsTab — étiquettes', () => {
  it('affiche les étiquettes de chaque réunion', () => {
    renderTab();
    const first = screen.getByRole('heading', { name: 'Comité projet' }).closest('li')!;
    expect(within(first).getByRole('button', { name: 'Filter by the “projet-x” tag' })).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: 'Filter by the “Hebdo” tag' })).toBeInTheDocument();
  });

  it('propose chaque étiquette une seule fois (casse ignorée), triées', () => {
    renderTab();
    const chips = tagFilter().getAllByRole('button').map((b) => b.textContent);
    expect(chips).toEqual(['All', 'entretien', 'Hebdo', 'projet-x']);
  });

  it('filtre par étiquette depuis la barre, et « Toutes » retire le filtre', async () => {
    renderTab();
    await userEvent.click(tagFilter().getByRole('button', { name: 'Hebdo' }));
    expect(titles()).toEqual(['Comité projet', 'Point équipe']);
    expect(screen.getByText('Results: 2 of 4')).toBeInTheDocument();
    expect(tagFilter().getByRole('button', { name: 'Hebdo' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(tagFilter().getByRole('button', { name: 'All' }));
    expect(titles()).toHaveLength(4);
  });

  it('un clic sur l’étiquette d’une réunion filtre, un second clic retire le filtre', async () => {
    renderTab();
    await userEvent.click(screen.getByRole('button', { name: 'Filter by the “entretien” tag' }));
    expect(titles()).toEqual(['Entretien Alice']);
    await userEvent.click(screen.getByRole('button', { name: 'Filter by the “entretien” tag' }));
    expect(titles()).toHaveLength(4);
  });

  it('se combine avec la recherche ; « Effacer les filtres » remet tout', async () => {
    renderTab();
    await userEvent.click(tagFilter().getByRole('button', { name: 'projet-x' }));
    await userEvent.type(screen.getByRole('searchbox'), 'alice');
    expect(screen.getByText('No meeting tagged “projet-x” matches “alice”. Try another word.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(titles()).toHaveLength(4);
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });
});

describe('RecordingsTab — transcription et résumé', () => {
  const segment = { text: 'Bonjour', speaker: 0, startTime: 0, endTime: 1, confidence: 1, language: 'fr-FR' };
  const row = (title: string) => within(screen.getByRole('heading', { name: title }).closest('li')!);

  beforeEach(() => {
    useTaskStore.setState({ transcriptions: {}, summary: null });
    useMeetingStore.setState({
      meetings: [
        { ...meeting('1', 'Résumée'), transcription: { sessionId: '1', segments: [segment], summary: '# Résumé' } },
        { ...meeting('2', 'Transcrite'), transcription: { sessionId: '2', segments: [segment] } },
        { ...meeting('3', 'Importée'), status: 'stopped' },
      ],
    });
  });

  it('dit pour chaque réunion si la transcription et le résumé existent', () => {
    renderTab();
    expect(row('Résumée').getByText('Transcript available')).toBeInTheDocument();
    expect(row('Résumée').getByText('Summary available')).toBeInTheDocument();
    expect(row('Transcrite').getByText('Transcript available')).toBeInTheDocument();
    expect(row('Transcrite').getByText('No summary yet')).toBeInTheDocument();
    expect(row('Importée').getByText('No transcript yet')).toBeInTheDocument();
    expect(row('Importée').getByText('No summary yet')).toBeInTheDocument();
  });

  it('montre une transcription ou un résumé en cours', () => {
    useTaskStore.setState({
      transcriptions: { '3': { ...EMPTY_TRANSCRIPTION, isTranscribing: true } },
      summary: {
        meetingId: '2',
        versionId: 'v1',
        meetingTitle: 'Transcrite',
        isGenerating: true,
        cancelRequested: false,
        streamText: '',
        result: null,
        error: null,
      },
    });
    renderTab();
    expect(row('Importée').getByText('Transcription in progress')).toBeInTheDocument();
    expect(row('Transcrite').getByText('Summary being generated')).toBeInTheDocument();
  });

  it('ne répète plus « Terminée » / « Non transcrite », garde les statuts d’échec', () => {
    useMeetingStore.setState({
      meetings: [{ ...meeting('4', 'Ratée'), status: 'failed' }, ...useMeetingStore.getState().meetings],
    });
    renderTab();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    expect(screen.queryByText('Not transcribed')).not.toBeInTheDocument();
    expect(row('Ratée').getByText('Failed')).toBeInTheDocument();
  });
});
