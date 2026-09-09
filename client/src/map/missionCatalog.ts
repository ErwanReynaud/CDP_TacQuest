// Figurés de mission de la section et du groupe (symbologie France, cf.
// resources/*.jpeg). Chaque figuré se trace comme une flèche : origine posée
// sous le réticule, direction/taille données par le déplacement de la carte.
// Le rendu est purement géographique (proportionnel au tracé) : il se calcule
// une fois en pixels puis vit en latlngs — le zoom le met à l'échelle seul.

export type MissionLevel = 'section' | 'groupe';
export type MissionCategory = 'offensive' | 'defensive' | 'surete';

export interface MissionDef {
  id: string;
  abbr: string;
  name: string;
  cat: MissionCategory;
  levels: MissionLevel[];
  /** Contenu SVG de l'aperçu (viewBox 64×36) affiché dans le panneau Tac. */
  preview: string;
  /** Figuré à deux flèches : on les trace l'une après l'autre (COUV/SURV/INTERD). */
  twoArrows?: boolean;
}

export const MISSION_CATEGORIES: Record<MissionCategory, string> = {
  offensive: 'Offensives',
  defensive: 'Défensives',
  surete: 'Sûreté',
};

const SG: MissionLevel[] = ['section', 'groupe'];
const S: MissionLevel[] = ['section'];
const G: MissionLevel[] = ['groupe'];

export const MISSIONS: MissionDef[] = [
  // --- offensives ---
  {
    id: 'semp', abbr: "S'EMP", name: "S'emparer de", cat: 'offensive', levels: SG,
    preview: '<ellipse cx="19" cy="13" rx="12" ry="7"/><path d="M30 16c9 3 13 7 13 13"/><path d="M38 24l5 5 2-7"/><text x="40" y="14">S</text>',
  },
  {
    id: 'app', abbr: 'APP', name: 'Appuyer', cat: 'offensive', levels: SG,
    preview: '<path d="M20 22h24M20 22l-8 9M44 22l8 9M20 22l-5-12M44 22l5-12"/><path d="M11 14l4-4 5 2M44 12l5-2 4 4"/>',
  },
  {
    id: 'appf', abbr: 'APP', name: 'Appuyer (flèche)', cat: 'offensive', levels: SG,
    preview: '<text x="4" y="12">APP</text><path d="M10 26h42M10 20l8 6-8 6M18 20l8 6-8 6"/><path d="M46 20l7 6-7 6"/>',
  },
  {
    id: 'sout', abbr: 'SOUT', name: 'Soutenir', cat: 'offensive', levels: S,
    preview: '<text x="4" y="12">SOUT</text><path d="M10 26h42M10 20l8 6-8 6M18 20l8 6-8 6"/><path d="M46 20l7 6-7 6"/>',
  },
  {
    id: 'neut', abbr: 'NEUT', name: 'Neutraliser', cat: 'offensive', levels: SG,
    preview: '<path d="M16 8l32 24M48 8 16 32" stroke-dasharray="5 5"/><text x="29" y="14">N</text>',
  },
  {
    id: 'det', abbr: 'DET', name: 'Détruire', cat: 'offensive', levels: G,
    preview: '<path d="M16 8l32 24M48 8 16 32"/><text x="29" y="14">D</text>',
  },
  {
    id: 'fix', abbr: 'FIX', name: 'Fixer', cat: 'offensive', levels: S,
    preview: '<path d="M6 26h8l4-9 6 18 6-18 6 18 4-9h8"/><path class="solid" d="M56 26l-9-6v12z"/>',
  },
  // --- défensives ---
  {
    id: 'interd', abbr: 'INTERD', name: 'Interdire', cat: 'defensive', levels: S, twoArrows: true,
    preview: '<path d="M10 30 50 9M10 9l40 21"/><path d="M42 6l8 3-5 6M42 33l8-3-5-6"/>',
  },
  {
    id: 'def', abbr: 'DEF', name: 'Défendre', cat: 'defensive', levels: S,
    preview: '<path d="M41.4 21.4A10 10 0 1 1 41.4 14.6"/><path d="M19 24l3-6 3 6"/><circle cx="32" cy="18" r="13" stroke-dasharray="1.5 4.5"/><text x="40" y="21">D</text>',
  },
  {
    id: 'ten', abbr: 'TEN', name: 'Tenir', cat: 'defensive', levels: SG,
    preview: '<path d="M41.4 21.4A10 10 0 1 1 41.4 14.6"/><path d="M19 24l3-6 3 6"/><circle cx="32" cy="18" r="13" stroke-dasharray="1.5 4.5"/><text x="40" y="21">R</text>',
  },
  {
    id: 'recu', abbr: 'RECU', name: 'Recueillir', cat: 'defensive', levels: S,
    preview: '<path d="M6 26h44M28 12v22"/><path class="solid" d="M56 26l-9-6v12z"/>',
  },
  // --- sûreté ---
  {
    id: 'ecl', abbr: 'ECL', name: 'Éclairer', cat: 'surete', levels: SG,
    preview: '<text x="8" y="12">ECL</text><path d="M8 26h18l6-8-4 13 6-5h18"/><path d="M46 20l7 6-7 6"/>',
  },
  {
    id: 'reco', abbr: 'RECO', name: 'Reconnaître', cat: 'surete', levels: SG,
    preview: '<text x="8" y="12">RECO</text><path d="M8 26h18l6-8-4 13 6-5h18"/><path d="M46 20l7 6-7 6"/>',
  },
  {
    id: 'couv', abbr: 'COUV', name: 'Couvrir', cat: 'surete', levels: SG, twoArrows: true,
    preview: '<path d="M28 28 24 20l4 3-8-13M36 28l4-8-4 3 8-13"/><path d="M20 17v-8l7 2M44 17V9l-7 2"/><text x="24" y="35">C</text><text x="36" y="35">C</text>',
  },
  {
    id: 'boucl', abbr: 'BOUCL', name: 'Boucler', cat: 'surete', levels: S,
    preview: '<path d="M43.7 20.5A12 12 0 0 1 34.5 29.7L32 24.5 29.5 29.7A12 12 0 0 1 20.3 20.5L25.5 18 20.3 15.5A12 12 0 0 1 29.5 6.3L32 11.5 34.5 6.3A12 12 0 0 1 43.7 15.5L38.5 18Z"/>',
  },
  {
    id: 'surv', abbr: 'SURV', name: 'Surveiller', cat: 'surete', levels: SG, twoArrows: true,
    preview: '<path d="M28 28 24 20l4 3-8-13M36 28l4-8-4 3 8-13"/><path d="M20 17v-8l7 2M44 17V9l-7 2"/><text x="24" y="35">S</text><text x="36" y="35">S</text>',
  },
];

export function missionDef(id: string): MissionDef | undefined {
  return MISSIONS.find((m) => m.id === id);
}
