import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateBanner } from './UpdateBanner';
import { useUpdateStore } from '../../store/updateStore';
import { useTaskStore } from '../../store/taskStore';

const UPDATE = { version: '0.5.0', currentVersion: '0.4.2', notes: null };
const install = vi.fn();

beforeEach(() => {
  install.mockReset().mockResolvedValue(undefined);
  useTaskStore.setState({ recording: null, summary: null, transcriptions: {} });
  useUpdateStore.setState({
    status: 'available',
    available: UPDATE,
    progress: null,
    error: null,
    dismissedVersion: null,
    checking: false,
    install,
  });
});

describe('UpdateBanner', () => {
  it('ne s’affiche pas sans nouvelle version', () => {
    useUpdateStore.setState({ status: 'idle', available: null });
    const { container } = render(<UpdateBanner automaticChecks={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('propose la nouvelle version et l’installe au clic', async () => {
    render(<UpdateBanner automaticChecks={false} />);

    expect(screen.getByText('SealedScribe 0.5.0 is available')).toBeInTheDocument();
    expect(screen.getByText(/You have version 0.4.2/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(install).toHaveBeenCalledOnce();
  });

  it('bloque l’installation pendant un enregistrement', () => {
    useTaskStore.setState({ recording: { startedAt: Date.now() } });
    render(<UpdateBanner automaticChecks={false} />);

    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
    expect(screen.getByText(/once the recording or processing in progress is over/)).toBeInTheDocument();
  });

  it('« Plus tard » masque le bandeau', async () => {
    render(<UpdateBanner automaticChecks={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));

    expect(screen.queryByText('SealedScribe 0.5.0 is available')).not.toBeInTheDocument();
  });

  it('affiche la progression du téléchargement, sans bouton', () => {
    useUpdateStore.setState({ status: 'downloading', progress: { downloaded: 25, total: 100 } });
    render(<UpdateBanner automaticChecks={false} />);

    expect(screen.getByText('Downloading the update… 25%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });
});
