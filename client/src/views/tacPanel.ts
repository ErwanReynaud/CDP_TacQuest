// Panneau « Tac » : figurés de mission (section / groupe) à poser sur la
// carte. Ouvert par le bouton Tac (sous Comms) ; choisir une mission ferme le
// panneau et lance le tracé.
import {
  MISSION_CATEGORIES,
  MISSIONS,
  type MissionCategory,
  type MissionLevel,
} from '../map/missionCatalog';
import { escapeHtml } from '../util';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface Deps {
  /** Lance le tracé du figuré choisi (le panneau vient de se fermer). */
  startMission: (id: string) => void;
}

let deps: Deps;
let level: MissionLevel = 'section';

export function initTacPanel(d: Deps): void {
  deps = d;
  $('btn-tac').addEventListener('click', () => toggleTac());
  $('tac-close').addEventListener('click', () => closeTac());

  document.querySelectorAll<HTMLButtonElement>('#tac-level button').forEach((btn) => {
    btn.addEventListener('click', () => {
      level = btn.dataset.level as MissionLevel;
      document
        .querySelectorAll('#tac-level button')
        .forEach((el) => el.classList.toggle('selected', el === btn));
      renderMissions();
    });
  });

  // Missions : délégation sur la grille.
  $('mission-list').addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.mission-card');
    if (!card?.dataset.mission) return;
    closeTac();
    deps.startMission(card.dataset.mission);
  });
}

export function toggleTac(): void {
  if ($('tac-panel').hidden) openTac();
  else closeTac();
}

export function openTac(): void {
  $('tac-panel').hidden = false;
  renderMissions();
}

export function closeTac(): void {
  $('tac-panel').hidden = true;
}

// --- rendu ---

function renderMissions(): void {
  const list = $('mission-list');
  list.replaceChildren();
  for (const cat of Object.keys(MISSION_CATEGORIES) as MissionCategory[]) {
    const missions = MISSIONS.filter((m) => m.cat === cat && m.levels.includes(level));
    if (!missions.length) continue;
    const h = document.createElement('p');
    h.className = 'mission-cat';
    h.textContent = MISSION_CATEGORIES[cat];
    list.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'mission-grid';
    for (const m of missions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mission-card';
      btn.dataset.mission = m.id;
      btn.innerHTML =
        `<svg viewBox="0 0 64 36" aria-hidden="true">${m.preview}</svg>` +
        `<b>${escapeHtml(m.abbr)}</b><small>${escapeHtml(m.name)}</small>`;
      grid.appendChild(btn);
    }
    list.appendChild(grid);
  }
}
