# CDP_TacQuest — refonte transport Meshtastic / LoRa

> **État du dépôt.** Le dépôt était vide à l'ouverture de cette session : seuls
> les 6 fichiers audités ont été fournis. `shared/src/protocol.ts` et
> `shared/src/constants.ts` sont ici tels que fournis (à la modification
> documentée près, cf. `docs/mesh/protocol.md` § 10). Le `package.json` racine
> et celui de `shared/` sont un échafaudage minimal destiné à faire tourner les
> tests — à fusionner avec la configuration réelle du workspace `@tq` quand le
> code applicatif sera poussé.

## Ce qui est ici

| Chemin | Contenu |
|---|---|
| `docs/mesh/protocol.md` | spécification du protocole binaire, correspondance Meshtastic, sémantique CRDT, périmètre non couvert en LoRa |
| `shared/src/mesh/constants.ts` | budgets, portnums, opcodes, palette, dictionnaires |
| `shared/src/mesh/geo.ts` | quantification ancre + delta int16 |
| `shared/src/mesh/bytes.ts` | curseurs de lecture/écriture, varints zigzag |
| `shared/src/mesh/ids.ts` | identifiants d'ordre courts `(node, seq)` |
| `shared/src/mesh/palette.ts` | couleurs et SIDC → index |
| `shared/src/mesh/codec.ts` | encodage/décodage des trames, ajustement au budget |
| `shared/test/` | 29 tests |

## Tests

Aucune dépendance à installer : Node 22 exécute le TypeScript nativement.

```sh
npm run test:mesh
```

## Reste à faire

Les étapes 3 à 7 de la mission demandent le code applicatif absent du dépôt
(`client/src/socket.ts` en particulier, la couche à remplacer) :

- couche transport BLE ↔ module Meshtastic (Web Bluetooth, caractéristiques GATT) ;
- couche CRDT (LWW-Register positions, OR-Set add-wins figurés) au-dessus du transport ;
- abstraction de transport rendant la logique applicative agnostique mesh/serveur ;
- détection iOS/Safari bloquante à l'installation et à la connexion BLE ;
- tests BLE/LoRa sur simulateur Meshtastic, puis sur matériel.
