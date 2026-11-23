import { AlertTriangle } from 'lucide-react';
import { useT } from '../../i18n';
import { DEFAULT_DEVICE, type AudioDevice, type ResolvedDevice, type SavedAudioDevice } from '../../lib/audioDevices';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface AudioDeviceSelectProps {
  id: string;
  label: string;
  /** Périphériques branchés ; `null` tant que la liste n'est pas chargée. */
  devices: AudioDevice[] | null;
  saved: SavedAudioDevice | null;
  resolved: ResolvedDevice;
  onChange: (device: SavedAudioDevice | null) => void;
  /** La liste s'ouvre : l'occasion de voir un périphérique branché entre-temps. */
  onOpen: () => void;
}

/**
 * Choix d'un micro ou d'une sortie audio pour l'enregistrement. Première entrée : le
 * périphérique par défaut de Windows, qui suit les changements faits dans Windows.
 */
export function AudioDeviceSelect({ id, label, devices, saved, resolved, onChange, onOpen }: AudioDeviceSelectProps) {
  const { t } = useT();
  const defaultDevice = devices?.find((device) => device.isDefault);
  // Liste pas encore chargée : le choix mémorisé reste affiché par son nom.
  const items: SavedAudioDevice[] = devices ?? (saved ? [saved] : []);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={resolved.id ?? DEFAULT_DEVICE}
        onValueChange={(value) => {
          if (value === DEFAULT_DEVICE) {
            onChange(null);
          } else {
            const device = items.find((item) => item.id === value);
            if (device) onChange({ id: device.id, name: device.name });
          }
        }}
        onOpenChange={(open) => {
          if (open) onOpen();
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_DEVICE}>
            {defaultDevice
              ? t('record.deviceDefault', { name: defaultDevice.name })
              : t('record.deviceDefaultUnknown')}
          </SelectItem>
          {items.map((device) => (
            <SelectItem key={device.id} value={device.id}>
              {device.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {resolved.missing && (
        <p role="status" className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span>{t('record.deviceMissing', { name: resolved.missing.name })}</span>
        </p>
      )}
    </div>
  );
}
