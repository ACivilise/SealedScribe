import { describe, expect, it } from 'vitest';
import { canGoBack, clipBox, placeBubble, stepAfterEvent, TOUR_STEPS } from './onboarding';

const at = (id: string) => TOUR_STEPS.findIndex((step) => step.id === id);

describe('TOUR_STEPS', () => {
  it('va des Paramètres au premier enregistrement, sans identifiant en double', () => {
    const ids = TOUR_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TOUR_STEPS[0]).toMatchObject({ id: 'welcome', scope: 'settings' });
    expect(TOUR_STEPS[TOUR_STEPS.length - 1]).toMatchObject({ id: 'meetings', scope: 'main' });
    // Les étapes des Paramètres viennent toutes avant celles de l'écran principal.
    const firstMain = TOUR_STEPS.findIndex((step) => step.scope === 'main');
    expect(TOUR_STEPS.slice(firstMain).every((step) => step.scope === 'main')).toBe(true);
  });
});

describe('stepAfterEvent', () => {
  it('passe à l’étape suivante quand l’action attendue arrive', () => {
    expect(stepAfterEvent(at('start'), 'recording-started')).toBe(at('stop'));
    expect(stepAfterEvent(at('stop'), 'recording-stopped')).toBe(at('save-meeting'));
    expect(stepAfterEvent(at('save-meeting'), 'meeting-saved')).toBe(at('meetings'));
  });

  it('Paramètres fermés avant la fin : saute à l’écran principal', () => {
    expect(stepAfterEvent(at('welcome'), 'settings-closed')).toBe(at('meeting-language'));
    expect(stepAfterEvent(at('engine'), 'settings-closed')).toBe(at('meeting-language'));
  });

  it('Démarrer avant d’avoir lu les étapes précédentes : saute à l’étape Arrêter', () => {
    expect(stepAfterEvent(at('devices'), 'recording-started')).toBe(at('stop'));
  });

  it('ignore une action qui ne concerne plus la visite', () => {
    expect(stepAfterEvent(at('devices'), 'settings-closed')).toBeUndefined();
    expect(stepAfterEvent(at('meetings'), 'recording-started')).toBeUndefined();
  });

  it('réunion jetée : retour au bouton Démarrer', () => {
    expect(stepAfterEvent(at('save-meeting'), 'meeting-discarded')).toBe(at('start'));
    expect(stepAfterEvent(at('devices'), 'meeting-discarded')).toBeUndefined();
  });
});

describe('canGoBack', () => {
  it('seulement vers une étape du même écran qui n’attend pas d’action', () => {
    expect(canGoBack(at('welcome'))).toBe(false);
    expect(canGoBack(at('engine'))).toBe(true);
    // Première étape de l'écran principal : la précédente est dans les Paramètres.
    expect(canGoBack(at('meeting-language'))).toBe(false);
    expect(canGoBack(at('devices'))).toBe(true);
    // La précédente attend une action (Démarrer).
    expect(canGoBack(at('stop'))).toBe(false);
  });
});

describe('placeBubble', () => {
  const bounds = { left: 0, top: 0, width: 1000, height: 800 };
  const bubble = { width: 300, height: 200 };

  it('sous la cible, centrée sur elle', () => {
    const target = { left: 400, top: 100, width: 200, height: 40 };
    expect(placeBubble(target, bubble, bounds)).toEqual({ left: 350, top: 152 });
  });

  it('au-dessus quand la place manque en dessous', () => {
    const target = { left: 400, top: 650, width: 200, height: 40 };
    expect(placeBubble(target, bubble, bounds)).toEqual({ left: 350, top: 438 });
  });

  it('en bas de la zone quand la place manque des deux côtés', () => {
    const target = { left: 400, top: 50, width: 200, height: 700 };
    expect(placeBubble(target, bubble, bounds).top).toBe(592);
  });

  it('reste dans la zone près d’un bord', () => {
    const target = { left: 0, top: 100, width: 40, height: 40 };
    expect(placeBubble(target, bubble, bounds).left).toBe(8);
  });

  it('centrée dans la zone sans cible', () => {
    expect(placeBubble(null, bubble, { left: 100, top: 50, width: 500, height: 400 })).toEqual({ left: 200, top: 150 });
  });
});

describe('clipBox', () => {
  it('garde la partie visible de la cible', () => {
    const bounds = { left: 100, top: 100, width: 400, height: 300 };
    expect(clipBox({ left: 50, top: 350, width: 200, height: 100 }, bounds)).toEqual({
      left: 100,
      top: 350,
      width: 150,
      height: 50,
    });
    expect(clipBox({ left: 0, top: 0, width: 50, height: 50 }, bounds)).toBeNull();
  });
});
