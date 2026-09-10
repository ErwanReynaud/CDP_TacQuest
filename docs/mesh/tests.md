# Validation de la liaison BLE et LoRa

Deux niveaux, complémentaires : ce qui est vérifié automatiquement à chaque
commit, et ce qui exige du matériel.

```sh
npm test        # les trois paquets
npm run typecheck
npm run build -w client   # la construction de production casse sur des choses
                          # que ni les tests ni le typecheck ne voient
```

---

## 1. Ce qui est couvert automatiquement

239 tests, dont 159 pour la couche mesh.

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
en moins de 300 octets ; ce sont les positions qui dominent le volume, d'où la
cadence portée à 120 s (`MESH_POSITION_INTERVAL_MS`).

---

## 2. Ce qui exige du matériel

Aucun test automatique ne couvre la couche physique : appairage GATT réel,
portée, duty cycle, comportement du firmware. Cette partie se valide avec au
moins **deux modules** et **un appareil Android sous Chrome** (ou un PC sous
Chrome/Edge).

### Préparation des modules

1. Flasher Meshtastic (2.6 ou plus récent, pour correspondre à
   `@meshtastic/core` 2.6.7).
2. Régler la **région** : `EU_868` en Europe. Sans région, le module n'émet pas.
3. Choisir le préréglage : `LongFast` par défaut ; `MediumSlow` si la portée
   compte plus que le débit.
4. Configurer le **même canal et la même PSK** sur tous les modules : c'est ce
   qui matérialise une salle TacQuest.
5. Vérifier que les modules se voient entre eux depuis l'application Meshtastic
   officielle **avant** de tester TacQuest. Cela sépare un problème de radio
   d'un problème d'application.

### Lire le panneau de diagnostic

Tiroir → **Diagnostic**. Le bloc « Liaison radio » se rafraîchit toutes les
deux secondes et se termine par une phrase qui dit quoi faire :

| Ce qu'affiche le panneau | Ce que ça veut dire |
|---|---|
| « Aucune trame reçue » | personne à portée, ou canal et clé différents |
| « aucune n'est décodable » | la radio marche, les versions de TacQuest divergent |
| « En attente d'un premier point GPS » | pas encore d'ancre de zone, rien ne peut être encodé |
| « Rattrapage en cours : N trous » | l'anti-entropie travaille, laisser quelques minutes |
| « Lien nominal, carte à jour » | rien à signaler |

La distinction entre « rien n'arrive » et « ça arrive mais c'est illisible » est
la plus utile des cinq : la première envoie vérifier la portée et la clé, la
seconde les versions installées. **Copier** emporte l'état radio et le journal
ensemble — séparés, ils ne veulent rien dire.

### Séquence de validation

| # | Étape | Attendu |
|---|---|---|
| 1 | Ouvrir TacQuest en **HTTPS** sur Android/Chrome | le tiroir affiche « Module radio · Connecter », actif |
| 2 | Toucher « Connecter », choisir le module | « Module radio connecté. », le bouton devient « Déconnecter » |
| 3 | Attendre un fix GPS | l'ancre de zone est établie (visible au journal `mesh`) |
| 4 | Sur le second appareil, même opération | chaque poste voit l'indicatif de l'autre dans le tiroir |
| 5 | Attendre 2 minutes | la position du pair apparaît sur la carte |
| 6 | Poser un plot ENI | il apparaît sur l'autre appareil en quelques secondes |
| 7 | Tracer un figuré de mission | il apparaît avec sa couleur et son figuré |
| 8 | Tracer un tracé libre très découpé | il arrive **légèrement lissé** — c'est `encodeOrderFitted` |
| 9 | Effacer toute la carte | un seul paquet, la carte se vide chez les deux |
| 10 | Éteindre un module 5 min, composer des ordres, rallumer | **sans rien faire**, le module revenu rattrape son retard en quelques minutes (digest puis réémission) |
| 10b | Répéter avec un **troisième** module, en éteignant l'auteur des ordres | le retardataire est servi par le tiers : c'est l'enveloppe `RELAY` qui le permet |
| 11 | Couper le Bluetooth pendant une émission | l'état passe à déconnecté, l'application ne se fige pas |
| 12 | Ouvrir le panneau de diagnostic à chaque étape | les compteurs bougent, et le diagnostic final dit « Lien nominal » |

### Vérifications de plateforme

| Appareil | Attendu |
|---|---|
| iPhone / iPad | page d'installation avec l'avertissement Apple ; bouton radio **inerte** avec le motif ; carte, GPS et mode serveur pleinement fonctionnels |
| Chrome de bureau en HTTPS | connexion possible |
| Application servie en **HTTP** | message « connexion sécurisée » — et non « navigateur non supporté » |
| Firefox, Safari de bureau | motif nommant le navigateur |

---

## 3. Ce qui n'est délibérément pas testé

- **La portée et le duty cycle** : hors de portée d'un test logiciel. Le
  gouverneur d'airtime est dimensionné sur les chiffres du § 1 ; il faut le
  confronter au terrain.
- **La resynchronisation complète** : elle n'existe pas par conception
  (`docs/mesh/protocol.md` § 6.3). Les tests de partition valident le
  rattrapage par réémission, pas un transfert d'état intégral.
- **Le pontage serveur → LoRa** : volontairement absent, un nœud pontant
  deviendrait le répéteur de toute une salle.
- **La persistance des ordres en mode mesh seul** : la file hors-ligne et sa
  persistance sont assurées par la couche serveur. Sans session serveur, les
  ordres reçus vivent en mémoire et ne survivent pas à une PWA tuée par l'OS.
