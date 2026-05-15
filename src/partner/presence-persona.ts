/**
 * Deterministic mapping from a collab `clientId` to a friendly persona. The persona is purely
 * client-derived (no protocol change) and is used to render a small icon + label chip on cells
 * where remote peers are present, so collaborators can identify each other at a glance.
 */

export interface PresencePersona {
  /** Phosphor regular icon name; rendered as `ph ph-{icon}`. */
  icon: string;
  /** Short, human-readable nickname (used in tooltips and as accessible labels). */
  label: string;
}

/**
 * Hand-picked Phosphor regular icons that exist in `@phosphor-icons/web@2.x` and read clearly
 * at 12px. Stay within /^[a-z0-9-]+$/ to satisfy the existing icon-name sanitizers.
 */
const PERSONAS: ReadonlyArray<PresencePersona> = [
  { icon: 'bird', label: 'Sparrow' },
  { icon: 'butterfly', label: 'Monarch' },
  { icon: 'cat', label: 'Tabby' },
  { icon: 'cow', label: 'Heifer' },
  { icon: 'dog', label: 'Hound' },
  { icon: 'fish', label: 'Tuna' },
  { icon: 'horse', label: 'Stallion' },
  { icon: 'rabbit', label: 'Hare' },
  { icon: 'shrimp', label: 'Krill' },
  { icon: 'bug', label: 'Beetle' },
  { icon: 'paw-print', label: 'Cub' },
  { icon: 'leaf', label: 'Fern' },
  { icon: 'tree', label: 'Oak' },
  { icon: 'flower', label: 'Daisy' },
  { icon: 'feather', label: 'Plume' },
  { icon: 'egg', label: 'Yolk' },
  { icon: 'mountains', label: 'Summit' },
  { icon: 'sun', label: 'Helios' },
  { icon: 'moon', label: 'Luna' },
  { icon: 'cloud', label: 'Cirrus' },
  { icon: 'lightning', label: 'Bolt' },
  { icon: 'fire', label: 'Ember' },
  { icon: 'snowflake', label: 'Flake' },
  { icon: 'drop', label: 'Dew' },
  { icon: 'planet', label: 'Astra' },
  { icon: 'star', label: 'Nova' },
  { icon: 'sparkle', label: 'Glint' },
  { icon: 'compass', label: 'Pilot' },
  { icon: 'anchor', label: 'Bosun' },
  { icon: 'kite', label: 'Drift' },
  { icon: 'cactus', label: 'Saguaro' },
  { icon: 'mushroom', label: 'Truffle' },
];

/** FNV-1a 32-bit, deterministic across sessions and tabs for a given `clientId`. */
function hashClientId(clientId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < clientId.length; i++) {
    h ^= clientId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Resolve the deterministic persona for a `clientId`. Falls back to the first entry on empty input. */
export function peerDisplayFromClientId(clientId: string): PresencePersona {
  if (!clientId) return PERSONAS[0]!;
  const idx = hashClientId(clientId) % PERSONAS.length;
  return PERSONAS[idx]!;
}
