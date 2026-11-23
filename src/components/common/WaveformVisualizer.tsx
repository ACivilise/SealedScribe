import { useState } from 'react';
import { motion } from 'motion/react';

interface WaveformVisualizerProps {
  audioLevel: number;
}

const BAR_COUNT = 24;
const MIN_BAR_HEIGHT_PX = 20;
const MAX_BAR_HEIGHT_PX = 100;

/**
 * Forme de référence des barres : tirée une seule fois au montage.
 * (Un Math.random() dans le rendu faisait sauter les barres à chaque re-rendu.)
 */
export default function WaveformVisualizer({ audioLevel }: WaveformVisualizerProps) {
  const [jitter] = useState(() =>
    Array.from({ length: BAR_COUNT }, () => Math.random() * 0.3)
  );

  return (
    // Hauteur fixe + scaleY : animer `height` faisait varier la hauteur du conteneur
    // et décalait toute l'interface en dessous à chaque mesure du niveau audio.
    <div
      className="flex items-center justify-center gap-1 py-6"
      style={{ height: MAX_BAR_HEIGHT_PX + 48 }}
      aria-hidden="true"
    >
      {jitter.map((variation, i) => {
        const baseHeight = Math.sin((i / BAR_COUNT) * Math.PI) * 0.5 + 0.3;
        const level = Math.min((baseHeight + variation) * audioLevel, 1);
        const heightPx = level * (MAX_BAR_HEIGHT_PX - MIN_BAR_HEIGHT_PX) + MIN_BAR_HEIGHT_PX;
        return (
          <motion.div
            key={i}
            initial={false}
            animate={{ scaleY: heightPx / MAX_BAR_HEIGHT_PX }}
            transition={{ duration: 0.1 }}
            style={{ height: MAX_BAR_HEIGHT_PX }}
            className="w-1 bg-primary rounded-full"
          />
        );
      })}
    </div>
  );
}
