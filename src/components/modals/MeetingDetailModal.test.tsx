import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MeetingDetailModal from './MeetingDetailModal';
import { useMeetingStore, type MeetingSession } from '../../store/meetingStore';
import { useTaskStore } from '../../store/taskStore';
import { generateSummary } from '../../services/summaryService';
import { useLexiconStore } from '../../store/lexiconStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock('../../services/summaryService', () => ({
  generateSummary: vi.fn(),
  cancelSummary: vi.fn().mockResolvedValue(undefined),
}));

const segment = (text: string) => ({ text, speaker: 0, startTime: 0, endTime: 1, confidence: 0.95, language: 'fr-FR' });

const meeting = (overrides: Partial<MeetingSession> = {}): MeetingSession => ({
  id: 'm1',
  title: 'Point projet',
  language: 'fr-FR',
  duration: 60,
  recordedAt: new Date('2026-11-10T10:00:00Z'),
  status: 'completed',
  speakers: [],
  transcriptionVersions: [{ id: 'v1', number: 1, createdAt: '2026-11-10T10:05:00Z', segments: [segment('On livre lundi.')] }],
  activeTranscriptionId: 'v1',
  transcription: { sessionId: 'm1', segments: [segment('On livre lundi.')] },
  ...overrides,
});

/** Comme RecordingsTab : la fiche suit la réunion du store. */
function Harness({
  onEditPrompts = vi.fn(),
  onClose = vi.fn(),
}: {
  onEditPrompts?: (id?: string) => void;
  onClose?: () => void;
}) {
  const current = useMeetingStore((s) => s.meetings.find((m) => m.id === 'm1'));
  return current ? <MeetingDetailModal meeting={current} onClose={onClose} onEditPrompts={onEditPrompts} /> : null;
}

const tagOf = (id: string) => useMeetingStore.getState().meetings.find((m) => m.id === id)?.tag;

const openSummaryTab = () => userEvent.click(screen.getByRole('tab', { name: 'Summary' }));

beforeEach(() => {
  useTaskStore.setState({ transcriptions: {}, recording: null, summary: null });
  useMeetingStore.setState({ meetings: [meeting()] });
  vi.mocked(generateSummary).mockReset();
  useLexiconStore.setState({ lexicons: [] });
});

describe('MeetingDetailModal — onglet Résumé', () => {
  it('génère le résumé de la transcription affichée et l’enregistre dans la version', async () => {
    vi.mocked(generateSummary).mockImplementation(async (_system, _prompt, onDelta) => {
      onDelta('Livraison lundi.');
      return { summary: 'Livraison lundi.', style: '', tokensUsed: 12, model: 'gpt', cancelled: false };
    });
    render(<Harness />);
    await openSummaryTab();
    expect(screen.getByText('No summary yet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Generate summary' }));

    const [, prompt] = vi.mocked(generateSummary).mock.calls[0];
    expect(prompt).toContain('On livre lundi.');
    expect(await screen.findByText('Livraison lundi.')).toBeInTheDocument();
    expect(useMeetingStore.getState().meetings[0].transcriptionVersions?.[0].summary).toBe('Livraison lundi.');
    expect(screen.getByRole('button', { name: 'Regenerate summary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy summary' })).toBeEnabled();
  });

  it('sans transcription : renvoie vers l’onglet Transcription, sans bouton Générer', async () => {
    useMeetingStore.setState({
      meetings: [meeting({ transcription: undefined, transcriptionVersions: [], activeTranscriptionId: undefined })],
    });
    render(<Harness />);
    await openSummaryTab();
    expect(screen.getByText(/Transcribe the recording first \(Transcript tab\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate summary' })).not.toBeInTheDocument();
  });

  it('un résumé en cours pour une autre réunion bloque la génération', async () => {
    useTaskStore.getState().setSummary({
      meetingId: 'autre',
      versionId: 'vx',
      meetingTitle: 'Autre',
      isGenerating: true,
      cancelRequested: false,
      streamText: '',
      result: null,
      error: null,
    });
    render(<Harness />);
    await openSummaryTab();
    expect(screen.getByRole('button', { name: 'Generate summary' })).toBeDisabled();
    expect(screen.getByText('Another summary is in progress.')).toBeInTheDocument();
  });

  it('s’ouvre sur le résumé en cours de génération et propose de l’arrêter', () => {
    useTaskStore.getState().setSummary({
      meetingId: 'm1',
      versionId: 'v1',
      meetingTitle: 'Point projet',
      isGenerating: true,
      cancelRequested: false,
      streamText: 'Livraison',
      result: null,
      error: null,
    });
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Livraison')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByLabelText('Transcript version')).toBeDisabled();
  });

  it('« Modifier les prompts » transmet le prompt choisi', async () => {
    const onEditPrompts = vi.fn();
    render(<Harness onEditPrompts={onEditPrompts} />);
    await openSummaryTab();
    await userEvent.click(screen.getByRole('button', { name: 'Edit prompts' }));
    expect(onEditPrompts).toHaveBeenCalledWith(expect.any(String));
  });
});

describe('MeetingDetailModal — étiquettes', () => {
  it('ajoute des étiquettes (Entrée, plusieurs à la fois) et en retire', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Add a tag' }));
    await userEvent.type(screen.getByLabelText('New tag'), 'projet-x, client{Enter}');
    expect(tagOf('m1')).toBe('projet-x, client');
    // Le champ reste ouvert pour la suivante.
    await userEvent.type(screen.getByLabelText('New tag'), 'hebdo{Enter}');
    expect(tagOf('m1')).toBe('projet-x, client, hebdo');

    await userEvent.click(screen.getByRole('button', { name: 'Remove the “client” tag' }));
    expect(tagOf('m1')).toBe('projet-x, hebdo');
  });

  it('reprend l’orthographe d’une étiquette d’une autre réunion', async () => {
    useMeetingStore.setState({ meetings: [meeting(), { ...meeting({ id: 'm2', tag: 'Hebdo' }) }] });
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Add a tag' }));
    await userEvent.type(screen.getByLabelText('New tag'), 'HEBDO{Enter}');
    expect(tagOf('m1')).toBe('Hebdo');
  });

  it('Échap annule la saisie sans fermer la fiche', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add a tag' }));
    await userEvent.type(screen.getByLabelText('New tag'), 'abandon{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('New tag')).not.toBeInTheDocument();
    expect(tagOf('m1')).toBeUndefined();
  });

  it('quitter le champ ajoute ce qui a été saisi', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Add a tag' }));
    await userEvent.type(screen.getByLabelText('New tag'), 'entretien');
    await userEvent.click(screen.getByRole('heading', { name: 'Point projet' }));
    expect(tagOf('m1')).toBe('entretien');
  });
});

describe('MeetingDetailModal — lexiques', () => {
  const withLexicon = () =>
    useLexiconStore.setState({
      lexicons: [
        { id: 'l1', name: 'Travail', enabled: true, entries: [{ id: 'e1', term: 'Zentra', variants: 'sentra, sen tra' }] },
      ],
    });
  const misheard = () =>
    meeting({
      audioPath: 'C:\rec\point.wav',
      transcriptionVersions: [
        { id: 'v1', number: 1, createdAt: '2026-11-10T10:05:00Z', segments: [segment('Le projet sentra avance.')], summary: 'Point sur sentra.' },
      ],
      transcription: { sessionId: 'm1', segments: [segment('Le projet sentra avance.')], summary: 'Point sur sentra.' },
    });

  it('corrige la transcription et le résumé de la version affichée', async () => {
    withLexicon();
    useMeetingStore.setState({ meetings: [misheard()] });
    render(<Harness />);
    await userEvent.click(screen.getByRole('tab', { name: 'Transcript' }));

    await userEvent.click(screen.getByRole('button', { name: 'Apply vocabulary' }));

    expect(screen.getByRole('status')).toHaveTextContent('Corrections: 2');
    expect(screen.getByText('Le projet Zentra avance.')).toBeInTheDocument();
    const version = useMeetingStore.getState().meetings[0].transcriptionVersions?.[0];
    expect(version?.segments[0].text).toBe('Le projet Zentra avance.');
    expect(version?.summary).toBe('Point sur Zentra.');
  });

  it('sans lexique actif, pas de bouton', async () => {
    useMeetingStore.setState({ meetings: [misheard()] });
    render(<Harness />);
    await userEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    expect(screen.queryByRole('button', { name: 'Apply vocabulary' })).not.toBeInTheDocument();
  });

  it('envoie au résumé le glossaire et une transcription corrigée', async () => {
    withLexicon();
    useMeetingStore.setState({ meetings: [misheard()] });
    vi.mocked(generateSummary).mockResolvedValue({ summary: 'ok', style: '', tokensUsed: 1, model: 'gpt', cancelled: false });
    render(<Harness />);
    await openSummaryTab();

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate summary' }));

    const [system, prompt] = vi.mocked(generateSummary).mock.calls[0];
    expect(system).toContain('- Zentra (may appear as: sentra, sen tra)');
    expect(prompt).toContain('Le projet Zentra avance.');
    expect(prompt).not.toContain('sentra');
  });
});
