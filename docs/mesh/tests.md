# Tests automatiques de la couche mesh

Ce que la CI vérifie à chaque poussée, et comment se servir du mesh simulé pour
travailler sans matériel.

> **Procédures de terrain :** [`docs/validation.md`](../validation.md).
> Ce document-ci s'adresse au développement ; celui-là à la campagne d'essais,
> en réseau comme hors réseau.

```sh
npm test        # les trois paquets
npm run typecheck
npm run build -w client   # la construction de production casse sur des choses
                          # que ni les tests ni le typecheck ne voient
```

---

## 1. Ce qui est couvert automatiquement

310 tests, dont 205 pour la couche mesh.

| Fichier | Ce qu'il verrouille |
|---|---|
| `shared/test/geo.test.ts` | quantification ancre + delta : aller-retour < 0,5 m aux quatre coins de l'enveloppe, refus hors enveloppe, hautes latitudes, équateur et antiméridien |
| `shared/test/codec.test.ts` | aller-retour de chaque type d'ordre, budgets d'octets, troncature UTF-8, rejet d'une version inconnue, trame tronquée, dégradation d'une mission hors catalogue |
| `client/src/mesh/platform.test.ts` | détection iOS/iPadOS/Safari/Firefox, contexte sécurisé, mode autonome ; **l'ordre des tests de `bleSupport`**, qui décide du diagnostic affiché |
| `client/src/mesh/bleRadio.test.ts` | refus avant chargement du code radio sur plateforme incapable, traduction d'un sélecteur fermé, préchargement silencieux |
| `client/src/mesh/positionCodec.test.ts` | conversion Position ↔ POSITION_APP, champs proto3 absents, position nulle d'un nœud sans fix |
| `client/src/mesh/portnums.test.ts` | chaque portnum confronté à l'énumération Meshtastic |
| `client/src/map/meshCatalog.test.ts` | dictionnaires de missions, SIDC et couleurs alignés sur l'UI |
| `client/src/crdt/*.test.ts` | add-wins, `clear`, compaction, convergence quel que soit l'ordre d'arrivée |
| `client/src/crdt/versionVector.test.ts` | intervalles fusionnés, distinction contigu / plus haut détenu, trous |
| `client/src/crdt/antiEntropy.test.ts` | réémission ciblée, gigue, suppression, digests tournants, demandes |
| `client/src/transport/meshTransport.test.ts` | bout-en-bout entre deux nœuds : encodage, diffusion, décodage, fusion, et rattrapage réel d'un ordre perdu |
| `shared/test/airtime.test.ts` | temps d'antenne confronté à la référence Semtech, budget de duty cycle à fenêtre glissante |
| `client/src/transport/airtimeGovernor.test.ts` | priorités, fusion des envois périmés, file saturée, cadence adaptative |
| `client/src/transport/meshStore.test.ts` | persistance locale des ordres, données relues corrompues, écriture différée |
| `client/src/state.test.ts` | correctifs d'audit : isolation du bus, session non persistée, fusion des snapshots |
| `client/src/mesh/meshScenario.test.ts` | mission de 30 min à 8 postes : convergence de tous les nœuds et budget radio |

### Le mesh simulé

`client/src/mesh/mockRadio.ts` implémente la même interface `Radio` que la
liaison BLE réelle. C'est ce qui rend testable, sans matériel, tout ce qui se
trouve au-dessus de la radio :

```ts
const mesh = new MockMesh({ lossRate: 0.4 });   // canal qui perd des paquets
const a = mesh.radio(0x11);
const b = mesh.radio(0x22);
mesh.partition('nord', [0x11]);                 // deux groupes hors portée
mesh.heal();                                    // contact rétabli
mesh.totalBytes();                              // volume émis
```

Le mesh simulé **lève** si une trame dépasse `MESH_MAX_PAYLOAD` : un encodage
trop gros échoue en test au lieu d'être découvert sur le terrain.

### Budget mesuré sur le scénario de référence

Section de 8 postes, 30 minutes, 6 figurés de mission, 6 plots, une suppression
et une correction :

| | Paquets | Octets |
|---|---|---|
| Ordres tactiques | 14 | **285** |
| Positions | 128 | 2 560 |
| **Total** | 142 | **2 845** |

Trame la plus grosse : **26 octets**. Toute la manœuvre d'une section tient donc
en moins de 300 octets.

Mais le volume n'est pas la limite. En temps d'antenne (LongFast, EU868), ces
142 trames réparties sur 8 postes représentent une trentaine d'émissions par
poste, soit environ **la moitié du budget horaire de chacun** — les positions
en consommant à elles seules 47 %. C'est cette contrainte, et non les octets,
que le gouverneur d'airtime arbitre (`docs/mesh/protocol.md` § 7).

---

---

## 2. Ce que les tests automatiques ne couvrent pas

Aucun test logiciel n'atteint la couche physique : appairage GATT réel, portée,
duty cycle, comportement du micrologiciel. Ces points se valident avec du
matériel, selon [`docs/validation.md`](../validation.md) § 3.

Restent aussi hors du champ automatique :

- **La portée et le duty cycle réels.** Le gouverneur d'airtime est dimensionné
  sur les estimations de `MESH_PRESETS`, tirées de la documentation et non
  d'une lecture du module — le point le plus incertain du projet, et il se
  mesure : [`docs/validation.md`](../validation.md) § 5.
- **La resynchronisation complète**, qui n'existe pas par conception
  ([`protocol.md`](protocol.md) § 6.3). Les tests de partition valident le
  rattrapage incrémental, pas un transfert d'état intégral.
- **Le pontage serveur → LoRa**, volontairement absent.
