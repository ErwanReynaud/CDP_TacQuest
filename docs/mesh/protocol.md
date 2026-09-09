# Protocole applicatif TacQuest sur Meshtastic

Version 1 — implémentation de référence : `shared/src/mesh/`, tests : `shared/test/`.

Ce document spécifie la couche applicative binaire que TacQuest transporte
au-dessus de Meshtastic/LoRa, en remplacement de la sérialisation JSON
Socket.IO. Il fixe le format des trames, la quantification des coordonnées, la
correspondance avec les types Meshtastic natifs, la sémantique CRDT, et la
liste explicite de ce qui n'est **pas** géré en mode LoRa.

---

## 1. Pourquoi une réécriture de la sérialisation

Le mode serveur dimensionne les ordres à `MAX_ORDER_BYTES = 16 384` octets.
Une trame LoRa en offre **200** : un facteur 80. Trois postes dominent le coût
d'un `OrderMessage` JSON actuel :

| Poste | JSON actuel | Binaire v1 |
|---|---|---|
| `id` (uuid) | 36 o | 2 o sur le fil (`seq`), le nœud vient de `packet.from` |
| `authorId` | 8-36 o | **0 o** — c'est `packet.from` |
| `ts` (epoch ms) | 13 o | 2-3 o (varint zigzag depuis l'époque de salle) |
| coordonnées (`lat`,`lng`) | ~40 o par point | **4 o** par point |

Un `remove` référence un second uuid : à lui seul, l'identifiant représentait
jusqu'à 32 octets binaires, soit 16 % du budget d'une trame. Il en coûte
désormais 8 octets au total.

---

## 2. Transport et adressage

Une **salle** TacQuest correspond à un **canal Meshtastic** (nom + PSK). Le
code de salle à 5 caractères (`ROOM_CODE_ALPHABET`, conçu pour être lu à la
voix) sert de nom de canal ; la PSK est distribuée avec lui (QR ou saisie).

Conséquence directe : il n'y a **pas d'autorité** pour allouer un code ni
garantir l'unicité d'un indicatif. `create_room` / `join_room` / `sessionToken`
n'ont pas d'équivalent mesh (cf. § 8).

L'identité d'un membre est le **numéro de nœud Meshtastic** (uint32). Le
`memberId` applicatif en est la forme hexadécimale sur 8 caractères
(`nodeToMemberId`), ce qui permet aux deux modes de partager le même roster.

### Portnums

| Usage | Portnum | Justification |
|---|---|---|
| Position des membres | `POSITION_APP` (3) | routage, `precision_bits` et store&forward natifs ; visible depuis un client Meshtastic standard |
| Indicatif / rôle | `NODEINFO_APP` (4) | `User.long_name` = indicatif, `short_name` = forme abrégée |
| Chat « Comms » | `TEXT_MESSAGE_APP` (1) | interopérable avec un client standard |
| Figurés, plots, missions, CRDT | **`PRIVATE_APP` (256)** | aucun type natif ne porte SIDC, échelon, couleur ni catalogue de mission |
| Alerte ENI (option) | `ALERT_APP` (71) | déclenche le buzzer du module en complément du plot |
| Rattrapage des retardataires | `STORE_FORWARD_APP` (65) | complète DIGEST/REQ (§ 6) |
| Configuration du module | `ADMIN_APP` (6) | assistant de mise en service uniquement, hors protocole applicatif |
| `ATAK_PLUGIN` (72) | **jamais émis** | référence de conception (payload propriétaire opaque sur portnum dédié), mais on n'usurpe pas le plugin d'un autre écosystème |

`WAYPOINT_APP` (8) n'est **pas** utilisé pour les plots : son schéma n'a ni
SIDC, ni couleur, ni la distinction point nommé / ENI. Une émission
*supplémentaire* en `WAYPOINT_APP`, pour rendre les plots visibles depuis un
client Meshtastic standard, reste possible en option — au prix du doublement de
l'airtime.

---

## 3. Quantification des coordonnées

**Ancre de zone d'opération + delta int16.**

Une ancre (`lat0`, `lng0`) est diffusée par l'opcode `ANCHOR` (8 o, en 1e-7
degré, même échelle que Meshtastic). Chaque point s'exprime ensuite en offsets
entiers **en mètres** depuis l'ancre :

```
dE : int16   (est,  ±32 767 m)
dN : int16   (nord, ±32 767 m)
```

soit **4 octets par point**, résolution **1 m**, enveloppe **±32,7 km**.

### Échelles

```
mètres/degré de latitude   k_lat(φ) = 111132,92 − 559,82·cos2φ + 1,175·cos4φ − 0,0023·cos6φ
mètres/degré de longitude  k_lng(φ) = 111412,84·cosφ − 93,5·cos3φ + 0,118·cos5φ
```

L'échelle en longitude est évaluée à la **latitude quantifiée du point**, pas à
celle de l'ancre. Ce détail n'est pas cosmétique : avec l'échelle de l'ancre, un
point situé à 32 km à l'est et 0,3° au nord d'une ancre à 45° dérive d'environ
**170 m**. Encodeur et décodeur exécutent la même séquence, donc l'aller-retour
est stable :

```
encode :  dN = round((lat − lat0) · k_lat(lat0))
          latQ = lat0 + dN / k_lat(lat0)
          dE = round((lng − lng0) · k_lng(latQ))

decode :  lat = lat0 + dN / k_lat(lat0)
          lng = lng0 + dE / k_lng(lat)
```

Erreur d'aller-retour mesurée aux quatre coins de l'enveloppe : **< 0,5 m** sur
chaque axe, très en deçà de la précision GPS de terrain.

### Règles

- Au-delà de **|lat| > 84°**, l'encodage est refusé : `cos φ` s'effondre et les
  offsets débordent. C'est aussi la limite de l'UTM, donc du MGRS affiché.
- Un point hors enveloppe fait échouer l'encodage (`MeshCodecError`) : c'est à
  l'appelant de renégocier une ancre, jamais au codec de tronquer.
### Convergence de l'ancre

`canonicalAnchor()` arrondit au 0,01° (~1 km) : deux nœuds partant du même
secteur tombent le plus souvent sur la même ancre sans se concerter. Cet
arrondi **réduit** la fréquence des désaccords, il ne les supprime pas — deux
points distants de quelques centaines de mètres de part et d'autre d'une
frontière de case divergent.

La convergence est donc assurée par la trame `ANCHOR`, selon une règle
déterministe que tous les nœuds appliquent sans négociation :

1. l'ancre portant le drapeau `originator` (celle du créateur de la salle)
   l'emporte ;
2. à défaut, l'ancre émise par le **plus petit numéro de nœud** l'emporte.

Un nœud qui adopte une ancre la réémet, ce qui propage le choix. Les offsets
déjà stockés sont recalculés à l'adoption : ils sont dérivés des `lat`/`lng`
applicatifs, jamais l'inverse.

---

## 4. Format des trames

### 4.1 Octet 0 — version et opcode

```
bits 7-4 : version du protocole (1)
bits 3-0 : opcode
```

Une trame dont la version diffère est **rejetée**, jamais interprétée au mieux.
Le canal étant chiffré par sa PSK, aucune protection supplémentaire contre le
trafic étranger sur `PRIVATE_APP` n'est nécessaire.

| Opcode | Nom | Porte un ordre |
|---|---|---|
| `0x0` | `ANCHOR` | non |
| `0x1` | `WAYPOINT` | oui |
| `0x2` | `GRAPHIC` | oui |
| `0x3` | `REMOVE` | oui |
| `0x4` | `ACK` | oui |
| `0x5` | `TEXT` | oui |
| `0x6` | `CLEAR_ALL` | oui |
| `0x7` | `DIGEST` | non |
| `0x8` | `REQ` | non |
| `0x9` | `MEMBER` | non |
| `0xA`-`0xF` | réservés | — |

### 4.2 En-tête des trames porteuses d'ordre

```
u8      version|opcode
u16 LE  seq                 identifiant de l'ordre (le nœud vient de packet.from)
zigzag  tsOffset            secondes depuis l'époque de la salle
```

`tsOffset` est en **zigzag** et non en varint simple : cela tolère une dérive
d'horloge plaçant un ordre avant l'époque de la salle, sans coûter d'octet
supplémentaire sur la plage utile (jusqu'à ±2 097 151 s en 3 o, soit 24 jours).

### 4.3 `WAYPOINT` (0x1)

```
en-tête
u8      attrs      bit7 hasColor · bit6 hasSidc · bits3-0 index de couleur
i16     dE
i16     dN
u8      sidcIdx    si bit6
str     name       longueur u8 + UTF-8, plafonné à 48 o
```

### 4.4 `GRAPHIC` (0x2)

```
en-tête
u8      gflags     bits1-0 géométrie · bit2 arrow · bit3 polygon
                   bit4 hasLabel · bit5 hasMission · bit6 hasEchelon
u8      style      bits3-0 index de couleur · bits7-4 épaisseur (0-15)
géométrie          (ci-dessous)
u8      missionIdx si bit5   (0xFF = inconnu)
u8      echelon    si bit6   (0 section · 1 company · 2 battalion)
str     label      si bit4, plafonné à 32 o
```

Géométrie, selon `gflags` bits 1-0 :

- **`0` LINE / `2` POLY** — `u8 n`, puis `i16 dE`, `i16 dN` pour le premier
  sommet, puis `n−1` paires de **deltas zigzag depuis le sommet précédent**. Un
  tracé fin (sommets espacés de quelques dizaines de mètres) coûte 2 o par
  point au lieu de 4.
- **`1` RECT** — `i16 dE`, `i16 dN`, `i16 w`, `i16 h`. Détecté automatiquement
  sur un polygone à axes alignés (tolérance 1 m, soit le pas de quantification)
  et redéveloppé en 5 sommets fermés au décodage.

### 4.5 `REMOVE` (0x3) et `ACK` (0x4)

```
en-tête
u8      rflags     bit0 : la cible a le même auteur que l'émetteur
u32     node       si bit0 = 0
u16     seq
```

### 4.6 `CLEAR_ALL` (0x6)

```
en-tête
zigzag  beforeTsOffset
```

Masque tout ordre dont `ts ≤ beforeTs`. Un seul paquet remplace les N `remove`
qu'émettait `clearWholeMap()` — 40 paquets pour une carte chargée.

### 4.7 `TEXT` (0x5)

```
en-tête
str     body       plafonné à 180 o
```

Utilisé uniquement quand le message doit porter un identifiant d'ordre pour le
journal CRDT ; le chat ordinaire passe par `TEXT_MESSAGE_APP`.

### 4.8 Trames de contrôle

```
ANCHOR   u8 hdr · i32 latE7 · i32 lngE7 · u32 epochSec · u8 flags(bit0 originator)
DIGEST   u8 hdr · u8 count · count × { u32 node, u16 upto }      (count ≤ 32)
REQ      u8 hdr · u32 node · u16 from · u8 count
MEMBER   u8 hdr · u8 flags(bit0 isLeader) · str callsign (≤ 16 o)
```

### 4.9 Tailles mesurées

Valeurs produites par l'implémentation (`shared/src/mesh/codec.ts`) :

| Message | Octets |
|---|---|
| `clear` (toute la carte) | **7** |
| `remove` / `ack` sur son propre ordre | **8** |
| `REQ` | 8 |
| `MEMBER` « ALPHA 11 » | 11 |
| `remove` sur l'ordre d'un autre nœud | 12 |
| `ANCHOR` | 14 |
| **rectangle (box) 500 × 500 m** | **15** |
| plot ENI « ENI » | 15 |
| flèche à 2 sommets | 16 |
| point nommé « OBJ ALPHA » | 20 |
| figuré de mission COUV (4 sommets) | 25 |
| liseré 3 sommets + label + échelon | 33 |
| texte de 40 caractères | 46 |
| `DIGEST` 32 entrées | 194 |

Le rectangle tient en **15 octets**, dans la cible de 10-15 octets du cahier des
charges.

### 4.10 Dépassement du budget

`encodeOrder()` **lève** `MeshCodecError` au-delà de 200 o : aucun dépassement
ne passe en silence, et les tests le vérifient.

La couche transport appelle `encodeOrderFitted()`, qui décime les sommets les
moins significatifs (critère d'aire de Visvalingam, extrémités préservées)
jusqu'à tenir dans le budget, et rapporte combien de sommets ont été sacrifiés.
Un tracé libre à 40 sommets est ainsi transmis légèrement lissé plutôt que
rejeté ou fragmenté — le bon compromis pour un figuré tactique, où un tracé
reçu à moitié serait pire qu'un tracé approché.

---

## 5. Dictionnaires

Sur le fil, toute chaîne fermée est un index. Ces tables **doivent être
identiques sur tous les nœuds d'une même version du protocole**.

| Champ | Codage | Comportement hors table |
|---|---|---|
| couleur | index 4 bits dans `MESH_PALETTE` (16 entrées) | rabattue sur l'entrée la plus proche en distance RVB |
| SIDC | index u8 dans `MESH_SIDC_DICT` (index 0 = `HOSTILE_SIDC`) | l'ordre part sans SIDC |
| mission | index u8 dans le catalogue client | émis en `0xFF` → `mission` absent au décodage, **rendu en ligne simple** |
| échelon | u8, `['section','company','battalion']` | ignoré |

La dégradation « mission inconnue → ligne simple » n'est pas une invention de
cette couche : `GraphicStyle.mission` la spécifie déjà (« identifiant du
catalogue client, inconnu → ligne simple »). Un nœud à jour peut donc émettre un
figuré qu'un nœud plus ancien affichera en trait simple, sans rien casser.

Les trois premières couleurs de la palette sont celles réellement câblées dans
l'UI (`#e8d44d` défaut des outils, `#0033ff` doctrine ami, `#d9a13b` mesure).

---

## 6. Synchronisation CRDT

Deux structures, choisies selon la nature de la donnée.

### 6.1 Positions — LWW-Register

Une position par membre, dernier écrit gagne. Le comparateur est le `ts` du fix
GPS. Les modules Meshtastic disposant d'une horloge disciplinée par GPS, la
dérive entre nœuds reste faible ; une égalité de `ts` est départagée par le
numéro de nœud, pour que tous les nœuds convergent vers la même valeur.

Les positions ne sont **pas** journalisées : seule la plus récente compte, une
position perdue est remplacée au fix suivant.

### 6.2 Figurés, plots, missions — OR-Set add-wins

- Chaque ordre est identifié par `(node, seq)`, unique par construction.
- Une suppression est un **tombstone** (`REMOVE`) référençant `(node, seq)`.
- **Add-wins** : une modification concurrente d'une suppression fait gagner
  l'objet.
- Les tombstones expirent après **24 h** (`TOMBSTONE_TTL_MS`, aligné sur
  `ROOM_EMPTY_TTL_MS`).

**Arbitrage assumé.** Un nœud resté hors portée plus de 24 h peut ressusciter un
objet supprimé pendant son absence. Le risque inverse — *remove-wins* — est plus
dangereux en usage tactique : une mise à jour fraîche d'un plot ENI que
quelqu'un venait de supprimer disparaîtrait **silencieusement**. Un figuré qui
réapparaît est visible et corrigible ; une mise à jour avalée ne l'est pas.

`CLEAR_ALL` est un tombstone en masse borné par `beforeTs` : il ne masque que
des ordres antérieurs, donc n'avale jamais un ordre concurrent plus récent.

### 6.3 Anti-entropie — jamais de resynchronisation complète

Une resynchronisation CRDT intégrale en une opération est **hors budget LoRa** et
n'est pas implémentée. Le rattrapage est incrémental :

- **`DIGEST`** — un nœud diffuse périodiquement, à faible cadence, un vecteur de
  versions partiel : pour chaque auteur connu, le plus haut `seq` contigu qu'il
  détient. À 6 octets par auteur et 40 membres possibles, le vecteur complet
  (240 o) ne tient pas dans une trame : on émet un **sous-ensemble tournant**
  d'au plus 32 entrées (194 o).
- **`REQ`** — demande explicite de réémission d'une plage `(node, from, count)`.
- Un nœud qui constate, à la lecture d'un `DIGEST`, qu'un pair lui manque des
  ordres qu'il détient les réémet avec **gigue et fenêtre de suppression**, pour
  qu'un seul nœud réponde plutôt que tous à la fois.
- `STORE_FORWARD_APP` complète le dispositif pour les retardataires quand un
  nœud de classe routeur est présent.

Au-delà du TTL de tombstone, la reprise passe **hors LoRa** : BLE, QR, ou le
serveur quand il est joignable.

`seq` boucle à 65 536 ; la comparaison se fait en arithmétique circulaire
(RFC 1982), valide sur un demi-espace — très au-delà du TTL de 24 h.

### 6.4 Conséquence sur le stockage

Le ring buffer `MAX_RECENT_ORDERS = 250` **casse la convergence** d'un OR-Set :
un nœud absent pendant plus de 250 ordres ne rattrapera jamais les entrées
tombées du buffer, sans qu'aucune couche ne s'en aperçoive. En mode mesh il est
remplacé par un magasin indexé sur `(node, seq)`, borné par le TTL des
tombstones et non par un nombre d'entrées.

---

## 7. Gouverneur d'airtime

Les garde-fous du mode serveur n'ont aucun sens sur radio :

- `ORDER_MAX_PER_WINDOW = 50` par 10 s, soit 5 messages/s, est **physiquement
  impossible** à 1 % de duty cycle EU868.
- `POSITION_INTERVAL_MS = 30 s` × 40 nœuds sature le canal à lui seul :
  `MESH_POSITION_INTERVAL_MS` porte l'intervalle à 120 s, et le gouverneur peut
  l'allonger davantage.
- Il n'y a pas de serveur pour appliquer `POSITION_MIN_INTERVAL_MS` ni renvoyer
  `RATE_LIMITED` : la limitation devient une discipline **locale**, appliquée
  avant émission, avec file d'attente et priorités (alerte ENI > ordre >
  position > digest).

---

## 8. Ce qui n'est délibérément PAS géré en mode LoRa

| Fonction | Raison | Repli |
|---|---|---|
| Position temps réel multi-utilisateurs à haute fréquence | duty cycle 1 % ; 40 nœuds à 30 s saturent le canal | intervalle porté à 120 s, `precision_bits` réduit |
| Transfert de fichiers / fonds de carte | des mégaoctets à ~1 kbit/s utile | tuiles préchargées avant sortie, hors bande |
| Audio | sans objet à ce débit | — |
| Resynchronisation CRDT complète en une opération | l'état complet dépasse de plusieurs ordres de grandeur une trame | `DIGEST`/`REQ` incrémentaux (§ 6.3), ou reprise hors LoRa |
| `create_room` / `join_room` avec unicité garantie | aucune autorité sur un mesh | salle = canal + PSK ; unicité d'indicatif **indicative**, conflit signalé et non prévenu |
| `sessionToken`, re-binding après coupure | pas de serveur pour valider un secret | identité = numéro de nœud + PSK du canal |
| Exclusion et clôture admin (`kicked`, `closed`) | pas d'autorité ; `ADMIN_APP` configure un module, pas une salle | retrait de la PSK et rotation du canal |
| Altitude (`fetchElevation`), géocodage, recherche de lieu | dépendent d'API HTTP | déjà dégradés hors ligne dans l'UI actuelle |
| `RATE_LIMITED` et contre-pression serveur | pas de serveur | gouverneur d'airtime local (§ 7) |

---

## 9. Coexistence mesh / serveur

La logique applicative ne connaît que `OrderMessage` et `Position` : c'est la
couche transport qui choisit le chemin. Le format d'identifiant `(node, seq)`
est utilisé **dans les deux modes** — le serveur n'interprète jamais `id`
(« enveloppe générique, jamais interprétée par le serveur »), donc ce choix est
purement client. Un nœud disposant des deux liens peut ainsi relayer un ordre
d'un mode à l'autre **sans table de correspondance**, et la déduplication par
`(node, seq)` fonctionne quel que soit le chemin emprunté.

---

## 10. Modifications apportées aux types partagés

| Fichier | Modification | Justification |
|---|---|---|
| `protocol.ts` | `OrderPayload` gagne `{ kind: 'clear'; beforeTs: number }` | effacement en masse en un paquet ; « un nouveau `kind` est un changement client uniquement » |
| `protocol.ts` | `graphic.geojson: unknown` → `LineStringFeature` | un codec binaire exige un ensemble fermé ; l'UI n'a jamais émis autre chose |
| `protocol.ts` | documentation du format de `id` | le format passe d'uuid à `node:seq` |

**Consommateurs à mettre à jour** (fichiers non fournis à ce jour) :
`map/orderFilter.ts` doit filtrer sur `clear`, et le rendu des Comms ne doit pas
afficher un `clear` comme un message.
