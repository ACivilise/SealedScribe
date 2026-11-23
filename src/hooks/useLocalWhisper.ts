import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { v4 as uuidv4 } from 'uuid';
import {
  INSTALL_PROGRESS_EVENT,
  InstallProgressEvent,
  LocalWhisperStatus,
  cancelInstall,
  deleteLocalModel,
  getLocalWhisperStatus,
  installLocalWhisper,
  unloadLocalWhisper,
} from '../services/localWhisperService';

/**
 * État du moteur local et actions des Paramètres : téléchargement avec progression,
 * annulation, libération de la mémoire graphique, suppression d'un modèle.
 */
export function useLocalWhisper() {
  const [status, setStatus] = useState<LocalWhisperStatus | null>(null);
  const [install, setInstall] = useState<InstallProgressEvent | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  /** Modèle ou composant en cours de téléchargement (un seul à la fois). */
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  /** Modèle ou composant visé par la dernière action : chaque section n'affiche que ses erreurs. */
  const [actionId, setActionId] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getLocalWhisperStatus());
    } catch (err) {
      console.error('Failed to read local whisper status:', err);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startInstall = useCallback(
    async (model: string) => {
      const jobId = uuidv4();
      jobIdRef.current = jobId;
      setIsInstalling(true);
      setInstallingId(model);
      setActionId(model);
      setCancelled(false);
      setError(null);
      setInstall(null);

      const unlisten = await listen<InstallProgressEvent>(INSTALL_PROGRESS_EVENT, (event) => {
        if (event.payload.modelId === model) setInstall(event.payload);
      }).catch(() => undefined);

      try {
        await installLocalWhisper(model, jobId);
      } catch (err) {
        const message = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
        if (message.includes('annulée')) {
          setCancelled(true);
        } else {
          setError(message);
        }
      } finally {
        unlisten?.();
        jobIdRef.current = null;
        setIsInstalling(false);
        setInstallingId(null);
        setInstall(null);
        await refresh();
      }
    },
    [refresh]
  );

  const cancel = useCallback(async () => {
    if (jobIdRef.current) await cancelInstall(jobIdRef.current).catch(() => false);
  }, []);

  const runAction = useCallback(
    async (action: () => Promise<void>, id: string | null = null) => {
      setIsBusy(true);
      setActionId(id);
      setCancelled(false);
      setError(null);
      try {
        await action();
      } catch (err) {
        setError(typeof err === 'string' ? err : err instanceof Error ? err.message : String(err));
      } finally {
        setIsBusy(false);
        await refresh();
      }
    },
    [refresh]
  );

  const unload = useCallback(() => runAction(unloadLocalWhisper), [runAction]);
  const remove = useCallback((model: string) => runAction(() => deleteLocalModel(model), model), [runAction]);

  return {
    status,
    install,
    isInstalling,
    installingId,
    actionId,
    isBusy,
    error,
    cancelled,
    refresh,
    startInstall,
    cancel,
    unload,
    remove,
  };
}

export default useLocalWhisper;
