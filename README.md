# TacQuest — coordination tactique, serveur ou mesh LoRa

PWA de coordination tactique : partage de position, figurés de mission,
plots ENI, messagerie. Carte Leaflet, coordonnées MGRS.

Deux transports interchangeables, invisibles pour la logique applicative :

- **serveur** — Socket.IO, quand une connexion réseau existe ;
- **mesh LoRa** — module Meshtastic appairé en Bluetooth, sans aucune
  infrastructure.

Les deux peuvent être actifs en même temps : un ordre composé localement part
sur les deux chemins, et la déduplication est assurée par le CRDT.

## Démarrage

```sh
npm ci
npm run dev        # serveur + client, http://localhost:5173
npm test           # les trois paquets
npm run typecheck
npm run build      # produit client/dist
```

> **Le mode radio exige du HTTPS.** Le Bluetooth Web n'existe qu'en contexte
> sécurisé : servie en `http://` depuis une IP de réseau local, l'application
> fonctionne (carte, GPS, mode serveur) mais aucun module ne peut être appairé.
> `localhost` fait exception. Le `Caddyfile` couvre les deux cas de
> déploiement, dont celui d'un portable de terrain sans internet — voir
> [`docs/mesh/tests.md`](docs/mesh/tests.md) § 2.

## Documentation

| Document | Contenu |
|---|---|
| [`docs/mesh/protocol.md`](docs/mesh/protocol.md) | protocole binaire, correspondance Meshtastic, sémantique CRDT, périmètre non couvert en LoRa |
| [`docs/mesh/tests.md`](docs/mesh/tests.md) | ce qui est vérifié automatiquement, et la séquence de validation avec du matériel |

## Organisation

```
shared/src/
  protocol.ts          types réseau partagés client/serveur
  constants.ts         limites et réglages du mode serveur
  mesh/                codec binaire LoRa : geo, bytes, ids, palette, codec
client/src/
  mesh/                radio : plateforme, BLE, position, mesh simulé
  crdt/                LWW-Register positions, OR-Set add-wins ordres,
                       vecteur de versions et anti-entropie
  transport/           façade serveur + mesh, identifiants, persistance,
                       gouverneur d'airtime
  map/, views/         carte et interface (inchangées)
server/src/            salles, ordres, administration
```

### Frontières

- `client/src/mesh/radio.ts` sépare strictement les deux mondes : au-dessus,
  aucune notion de Meshtastic, de BLE ni de protobuf ; en dessous, aucune
  notion d'ordre, de salle ni de figuré.
- `client/src/transport/` est le seul point d'entrée de la logique applicative.
  `socket.ts` n'est plus importé que par cette façade.
- La pile Meshtastic est chargée dynamiquement : seuls les postes qui appairent
  réellement un module téléchargent ses 71 ko compressés.

## Plateformes

| Plateforme | Carte, GPS, mode serveur | Mesh LoRa |
|---|---|---|
| Android / Chrome | oui | oui |
| Bureau / Chrome, Edge (HTTPS) | oui | oui |
| iPhone, iPad | oui | **non** — Apple n'implémente pas le Bluetooth Web |
| Firefox, Safari de bureau | oui | non |

L'indisponibilité du mode radio est annoncée à l'installation **et** à la
tentative de connexion, avec la cause et le recours. Une application servie en
HTTP simple signale qu'il faut du HTTPS, et non que le navigateur est
incompatible.

## Reste à faire

- Validation sur matériel : séquence dans [`docs/mesh/tests.md`](docs/mesh/tests.md).
- Reliquat d'audit, mineur : le code de salle n'est pas validé contre
  `ROOM_CODE_ALPHABET` côté client, `navigator.clipboard` est appelé sans garde
  dans le partage du code, et `#btn-replace` échappe à `setBusy`.
