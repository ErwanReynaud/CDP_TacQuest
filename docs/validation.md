# Campagne de validation TacQuest

Document de terrain. Il couvre les deux modes de fonctionnement :

- **en réseau** — mode serveur, ne demande aucun module radio ;
- **hors réseau** — mesh LoRa, demande au moins deux modules Meshtastic.

Les deux parties sont indépendantes. La partie réseau se fait dès aujourd'hui,
en salle ; la partie hors réseau attend le matériel. Faire la première d'abord
n'est pas seulement possible, c'est souhaitable : elle écarte tout ce qui n'a
rien à voir avec la radio, et il n'y a rien de pire que de déboguer une carte
qui ne s'affiche pas alors qu'on cherchait un problème de portée.

Barème commun à toutes les fiches : **✓** conforme · **✗** échec · **~** partiel
ou à revoir · **n/a** non applicable.

---

## 0. Avant toute sortie — vérifications automatiques

Trois commandes, à la racine du dépôt. Aucune ne doit échouer.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

| # | Attendu | Résultat |
|---|---|---|
| 0.1 | `npm ci` termine sans erreur | |
| 0.2 | `npm run typecheck` : aucune sortie d'erreur | |
| 0.3 | `npm test` : 310 tests, 0 échec | |
| 0.4 | `npm run build` : construction réussie, `client/dist` produit | |

La construction fait partie du lot délibérément : elle a déjà cassé sur des
choses que ni les tests ni le typecheck ne voient — `@meshtastic/core` importe
des modules Node absents du navigateur. Un client qui ne se construit plus ne se
déploie plus, donc ne se teste plus.

---

## 1. Monter le banc

### 1.1 Le HTTPS n'est pas optionnel

Trois fonctions de l'application exigent un **contexte sécurisé** :

| Fonction | Sans HTTPS |
|---|---|
| Géolocalisation | refusée — la carte marche, mais on ne s'y positionne jamais |
| Service worker (PWA) | pas d'installation, pas de hors-ligne |
| Bluetooth Web | `navigator.bluetooth` absent — aucun module appairable |

C'est le premier écueil d'une sortie terrain, et le plus déroutant, parce qu'il
n'a **rien à voir avec la radio**. Servie en `http://` depuis une adresse IP de
réseau local, l'application s'affiche parfaitement et ne fait rien de ce qu'on
attend d'elle.

Seule exception : `http://localhost` est considéré comme sécurisé. Un test sur
le portable qui héberge le serveur fonctionne donc sans TLS. Sur un téléphone,
jamais.

### 1.2 Trois façons d'obtenir du HTTPS

| Situation | Moyen | Certificat à installer |
|---|---|---|
| Démonstration, essais à plusieurs | `fly deploy` (cf. `fly.toml`) | non |
| Essai depuis son poste, sans déployer | `tailscale serve` (les hôtes `.ts.net` sont déjà autorisés dans `vite.config.ts`) | non |
| **Terrain, sans internet** | `caddy run`, second bloc du `Caddyfile` | **oui, sur chaque téléphone** |

Pour le troisième cas :

```sh
npm ci
npm run build          # produit client/dist
npm start              # serveur Node sur :3000
caddy run              # TLS devant, avec sa propre autorité
```

Caddy génère son propre certificat racine :

```
~/.local/share/caddy/pki/authorities/local/root.crt
```

→ Téléphone : Paramètres → Sécurité → Installer un certificat.

### 1.3 À faire à la base, avec du réseau

Ces quatre points **ne peuvent plus être réglés sur le terrain**. Les cocher
avant de partir.

| # | Vérification | Résultat |
|---|---|---|
| 1.1 | La page s'ouvre en HTTPS sur chaque téléphone, cadenas sans avertissement | |
| 1.2 | L'application est installée en PWA sur chaque téléphone | |
| 1.3 | Le code radio est en cache : ouvrir l'app **une fois avec du réseau** (71 ko préchargés en tâche de fond) | |
| 1.4 | Les modules se voient entre eux **depuis l'application Meshtastic officielle**, avant tout essai TacQuest | |

Le point 1.4 est le plus important de la campagne : il sépare un problème de
radio d'un problème d'application. Sans lui, tout échec ultérieur est ambigu.

---

## 2. Validation en réseau — mode serveur

**Matériel** : deux appareils minimum (téléphone + ordinateur suffisent).
**Aucun module radio n'est nécessaire.**

### 2.1 Démarrage et installation

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 2.1.1 | Ouvrir l'application sur ordinateur | la carte s'affiche, centrée sur la France en attendant le premier point | |
| 2.1.2 | Autoriser la géolocalisation | la carte se recentre sur la position, à un niveau de zoom rapproché | |
| 2.1.3 | Refuser la géolocalisation | l'écran « Position indisponible » apparaît, avec **Réessayer** et **Continuer sans position** | |
| 2.1.4 | Toucher **Continuer sans position** | la carte reste utilisable, sans point personnel | |
| 2.1.5 | Ouvrir sur téléphone Android dans le navigateur | la page d'installation s'affiche avec les consignes Chrome | |
| 2.1.6 | Toucher **Continuer dans le navigateur** | l'application démarre, et la page d'installation ne réapparaît plus | |
| 2.1.7 | Installer la PWA, la lancer depuis l'icône | plein écran, sans barre d'adresse, page d'installation absente | |
| 2.1.8 | Ouvrir sur **ordinateur** | aucune page d'installation : elle est réservée au mobile | |

### 2.2 Carte seule (mode solo, sans salle)

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 2.2.1 | Basculer MGRS → UTM → Géo (tiroir, ou tap sur les coordonnées) | l'affichage change de format, le choix est mémorisé | |
| 2.2.2 | Activer le quadrillage kilométrique | la grille apparaît et se met à l'échelle au zoom | |
| 2.2.3 | Poser un plot ENI (**Plot ennemi**) | losange rouge, avec sa désignation | |
| 2.2.4 | Poser un point nommé (**Ploter un point nommé**) | rond de la couleur choisie, avec son nom | |
| 2.2.5 | Tracer un liseré, lui donner un nom et un figuré d'échelon | le tracé porte son libellé et son figuré | |
| 2.2.6 | Tracer une flèche, une box | rendus conformes | |
| 2.2.7 | **Mesurer une distance** | la distance s'affiche pendant le tracé et le tracé ne persiste pas | |
| 2.2.8 | Recharger la page | **tous les figurés sont retrouvés** (carte solo persistée) | |
| 2.2.9 | **Tout effacer** | confirmation demandée, puis la carte est vide | |
| 2.2.10 | Recharger à nouveau | la carte reste vide | |

### 2.3 Salles

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 2.3.1 | **Collab** → saisir un indicatif → **Créer une salle** | la salle s'ouvre, son code à 5 caractères s'affiche en haut | |
| 2.3.2 | Sur le second appareil : **Collab** → indicatif + code → **Rejoindre** | entrée dans la salle, les deux indicatifs apparaissent dans le tiroir | |
| 2.3.3 | Le compteur de membres | affiche **2** sur les deux appareils | |
| 2.3.4 | Saisir un code trop court | message indiquant la longueur attendue **et le nombre saisi** | |
| 2.3.5 | Saisir un code contenant `O`, `0`, `I`, `L` ou `1` | message nommant les caractères jamais employés, et expliquant pourquoi (lecture à la voix) | |
| 2.3.6 | Saisir un code valide mais inexistant | « Salle introuvable », et l'entrée est retirée de l'historique si elle y était | |
| 2.3.7 | Rouvrir **Collab** | l'historique des salles récentes est proposé, indicatif prérempli | |
| 2.3.8 | Toucher une salle de l'historique | jonction directe, sans ressaisie | |
| 2.3.9 | Toucher la croix d'une entrée d'historique | l'entrée disparaît | |
| 2.3.10 | Toucher le code de salle en haut | partage natif, ou copie, **ou affichage du code** — jamais rien | |
| 2.3.11 | Rejoindre avec un indicatif déjà pris par un membre **connecté** | refus explicite | |
| 2.3.12 | **Quitter** la salle | confirmation, puis retour en carte solo avec les figurés solo | |

### 2.4 Positions et roster

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 2.4.1 | Attendre 30 s (`POSITION_INTERVAL_MS`) | la position de l'équipier apparaît sur la carte de l'autre | |
| 2.4.2 | Ouvrir le tiroir | chaque membre est listé avec l'ancienneté de sa position | |
| 2.4.3 | Toucher **Centrer** sur un membre | la carte se centre sur lui, le tiroir se referme | |
| 2.4.4 | Toucher le marqueur d'un équipier | infobulle : indicatif, coordonnées, altitude, précision, ancienneté | |
| 2.4.5 | Se déplacer de quelques dizaines de mètres | la position se met à jour chez l'autre au cycle suivant | |
| 2.4.6 | Fermer l'app d'un équipier | son marqueur passe en grisé, le compteur de connectés décroît | |

### 2.5 Figurés partagés

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 2.5.1 | Poser un plot ENI depuis l'appareil A | il apparaît chez B en quelques secondes | |
| 2.5.2 | Poser un point nommé coloré | couleur et nom identiques chez B | |
| 2.5.3 | Tracer un figuré de mission (**Figurés de mission** → RECO) | le figuré arrive chez B avec sa forme et sa couleur | |
| 2.5.4 | Tracer un figuré à deux flèches (COUV, SURV ou INTERD) | les deux flèches sont demandées l'une après l'autre, le rendu arrive complet | |
| 2.5.5 | Rééditer un plot existant (toucher, modifier le nom) | **le plot est remplacé, pas dupliqué**, chez A comme chez B | |
| 2.5.6 | Supprimer un figuré depuis B | il disparaît aussi chez A | |
| 2.5.7 | **Tout effacer** depuis A | la carte se vide chez les deux, après confirmation | |
| 2.5.8 | Vérifier qu'il n'existe pas de droits différenciés | **chacun peut effacer ou modifier le tracé d'un autre** — comportement voulu | |

### 2.6 Comms

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 2.6.1 | Ouvrir **Comms**, envoyer un message depuis A | il apparaît chez B, avec l'indicatif de l'émetteur | |
| 2.6.2 | B a le panneau fermé | badge de non-lus sur le bouton Comms, et notification | |
| 2.6.3 | B ouvre le panneau | le badge retombe à zéro | |
| 2.6.4 | Envoyer un message avec accents et emoji | restitué intact | |

### 2.7 Résilience

C'est la section la plus importante de la partie réseau : elle couvre les
correctifs d'audit récents.

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 2.7.1 | Couper le réseau de A (mode avion) | la pastille de connexion passe à « Reconnexion… » | |
| 2.7.2 | Poser un figuré hors ligne | il s'affiche localement, avec un badge « à synchroniser » | |
| 2.7.3 | Rétablir le réseau | le figuré part, le badge retombe, B le reçoit | |
| 2.7.4 | Recharger A pendant la coupure | le figuré en attente est **toujours là** après rechargement | |
| 2.7.5 | Fermer l'app de A, la rouvrir | A **retrouve sa place dans la salle** sans ressaisir le code | |
| 2.7.6 | Tuer l'app depuis le gestionnaire de tâches, relancer | idem : la session survit | |
| 2.7.7 | Laisser A hors ligne, poser 5 figurés depuis B, reconnecter A | A reçoit les 5 | |
| 2.7.8 | Après reconnexion, vérifier le tiroir | **A apparaît toujours dans sa propre liste** (sa position n'a pas disparu) | |
| 2.7.9 | Après une longue session à deux, reconnecter | **aucun figuré ancien n'a disparu** chez le client reconnecté | |
| 2.7.10 | Quitter la salle | la pastille de connexion ne reste pas sur « Connecté » | |

### 2.8 Cas limites et messages d'erreur

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 2.8.1 | Ouvrir sur **iPhone ou iPad** | l'app fonctionne : carte, GPS, salle, figurés | |
| 2.8.2 | iOS : page d'installation | avertissement expliquant que le module radio ne sera pas accessible, en nommant Apple | |
| 2.8.3 | iOS : tiroir → Module radio | bouton **inerte**, motif affiché — pas un échec silencieux | |
| 2.8.4 | Servir en `http://` sur un réseau local, ouvrir sur téléphone | le motif indique qu'il faut du **HTTPS**, pas que le navigateur est incompatible | |
| 2.8.5 | Ouvrir dans Firefox de bureau | motif nommant Firefox | |
| 2.8.6 | Couper le réseau, chercher un lieu | « Recherche indisponible (hors-ligne ?) » | |
| 2.8.7 | Ouvrir le panneau **Diagnostic** sans module | « Aucun module radio connecté », mode radio inactif | |

---

## 3. Validation hors réseau — mesh LoRa

**Matériel** : au moins **deux modules** Meshtastic (trois pour la section 3.5),
un appareil Android sous Chrome ou un PC sous Chrome/Edge par module.

### 3.1 Préparation des modules

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 3.1.1 | Micrologiciel Meshtastic 2.6 ou plus récent | correspond à `@meshtastic/core` 2.6.7 | |
| 3.1.2 | Région réglée (`EU_868` en Europe) | **sans région, le module n'émet pas** | |
| 3.1.3 | Préréglage noté : LongFast, MediumSlow… | à consigner en § 4.1 — toute l'arithmétique d'airtime en dépend | |
| 3.1.4 | Même canal et **même PSK** sur tous les modules | c'est ce qui matérialise une salle TacQuest | |
| 3.1.5 | Les modules se voient dans l'application Meshtastic officielle | **à faire avant TacQuest**, sans quoi tout échec est ambigu | |

### 3.2 Appairage BLE

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 3.2.1 | Tiroir → Module radio → **Connecter** | le sélecteur Bluetooth du navigateur s'ouvre | |
| 3.2.2 | Choisir le module | « Module radio connecté. », le bouton devient **Déconnecter** | |
| 3.2.3 | Fermer le sélecteur sans choisir | message parlant sur le module allumé et à portée — pas une trace technique | |
| 3.2.4 | Panneau **Diagnostic** | état « connecté », numéro de nœud en hexadécimal | |
| 3.2.5 | Attendre un point GPS | l'ancre de zone s'établit (visible au diagnostic) | |
| 3.2.6 | Couper le Bluetooth pendant la liaison | l'état passe à déconnecté, **l'application ne se fige pas** | |
| 3.2.7 | Reconnecter | la liaison repart | |

### 3.3 Liaison à deux

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 3.3.1 | Appairer un module sur chaque appareil | les deux affichent « connecté » | |
| 3.3.2 | Attendre | chaque poste voit **l'indicatif de l'autre** dans le tiroir | |
| 3.3.3 | Attendre 2 min (`MESH_POSITION_INTERVAL_MS`) | la position du pair apparaît sur la carte | |
| 3.3.4 | Poser un plot ENI | il arrive chez l'autre en quelques secondes | |
| 3.3.5 | Tracer un figuré de mission | il arrive avec sa couleur et sa forme | |
| 3.3.6 | Tracer un tracé libre **très découpé** (20 sommets ou plus) | il arrive **légèrement lissé** — c'est la simplification automatique, pas un défaut | |
| 3.3.7 | Supprimer un figuré | la suppression se propage | |
| 3.3.8 | **Tout effacer** | la carte se vide chez les deux ; au diagnostic, **une seule trame émise** | |
| 3.3.9 | Envoyer un message Comms | il arrive chez l'autre | |

### 3.4 Rattrapage automatique

Le cœur de la conception mesh : ce qui a été perdu doit revenir **sans que
personne n'intervienne**.

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 3.4.1 | Éteindre le module de B | A reste seul | |
| 3.4.2 | Depuis A, poser 3 figurés | A les voit, B non | |
| 3.4.3 | Rallumer le module de B, **ne rien faire** | B rattrape les 3 figurés en quelques minutes | |
| 3.4.4 | Noter le délai de rattrapage | attendu : quelques minutes (digest toutes les 5 min, gigue jusqu'à 15 s) | |
| 3.4.5 | Diagnostic chez B pendant le rattrapage | « Rattrapage en cours : N trous à combler » | |
| 3.4.6 | Diagnostic après | « Lien nominal, carte à jour » | |
| 3.4.7 | Une fois à jour, laisser tourner 15 min | **aucune réémission inutile** : seuls des digests de moins de 20 octets | |

### 3.5 Relais par un tiers — le test décisif

Avec **trois modules**. C'est ce test qui valide l'enveloppe `RELAY`, et il ne
peut pas être simulé de façon convaincante : si un retardataire ne peut être
servi que par l'auteur de l'ordre, ce n'est pas un mesh.

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 3.5.1 | Trois postes A, B, C appairés et à jour | | |
| 3.5.2 | Éteindre le module de C | | |
| 3.5.3 | Depuis A, poser 3 figurés | B les reçoit | |
| 3.5.4 | **Éteindre le module de A** | seul B détient les figurés | |
| 3.5.5 | Rallumer C, ne rien faire | **C reçoit les figurés de A, servis par B** | |
| 3.5.6 | Vérifier chez C l'auteur des figurés | l'auteur affiché est **A**, pas B | |

Le point 3.5.6 est le vrai critère : si l'auteur affiché était B, l'identité
serait corrompue au relais, et une suppression ultérieure viserait le mauvais
figuré.

### 3.6 Lire le panneau de diagnostic

Tiroir → **Diagnostic**. Le bloc « Liaison radio » se rafraîchit toutes les deux
secondes et se termine par une phrase qui dit quoi faire. À garder sous les yeux
pendant toute la campagne.

| Ce qu'affiche le panneau | Ce que ça veut dire | Quoi faire |
|---|---|---|
| « Aucune trame reçue » | personne à portée, ou canal et clé différents | se rapprocher, vérifier canal et PSK |
| « aucune n'est décodable » | la radio marche, les **versions de TacQuest divergent** | réinstaller la même version partout |
| « En attente d'un premier point GPS » | pas d'ancre de zone, rien ne peut être encodé | sortir à ciel ouvert, attendre le fix |
| « Rattrapage en cours : N trous » | l'anti-entropie travaille | laisser quelques minutes |
| « Budget radio presque épuisé » | duty cycle atteint, les envois passent en file | ralentir, ou attendre |
| « Lien nominal, carte à jour » | rien à signaler | — |

La distinction entre « rien n'arrive » et « ça arrive mais c'est illisible » est
la plus utile des six : la première envoie vérifier la portée et la clé, la
seconde les versions installées. Sans elle, un problème de version se
diagnostique comme un problème de portée, et on passe l'après-midi à rapprocher
les modules.

**Copier** emporte l'état radio **et** le journal ensemble — séparés, ils ne
veulent rien dire.

### 3.7 Budget d'airtime

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 3.7.1 | Diagnostic → ligne **Airtime** | pourcentage du budget horaire consommé | |
| 3.7.2 | Tracer une vingtaine de figurés d'affilée | la charge monte visiblement | |
| 3.7.3 | Dépasser 90 % | « Budget radio presque épuisé », les envois passent **en file** au lieu d'être perdus | |
| 3.7.4 | Continuer à poser des figurés | ils partent au fur et à mesure que le budget se libère | |
| 3.7.5 | Observer l'espacement des positions sous forte charge | l'intervalle s'allonge automatiquement | |
| 3.7.6 | Consigner les compteurs après une heure de session | fiche § 4.2 | |

### 3.8 Portée

À faire en terrain représentatif. Consigner dans la fiche § 4.3.

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 3.8.1 | Départ au contact, s'éloigner par paliers | noter à chaque palier la distance et si les figurés passent | |
| 3.8.2 | Noter la distance du **premier échec** | | |
| 3.8.3 | Noter la distance de la **perte complète** | | |
| 3.8.4 | Se rapprocher | le rattrapage automatique doit ramener ce qui a été manqué | |
| 3.8.5 | Répéter en terrain masqué (bâti, relief, végétation) | | |

### 3.9 Persistance et reprise

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 3.9.1 | Session mesh avec une carte chargée | | |
| 3.9.2 | **Tuer l'application** depuis le gestionnaire de tâches | | |
| 3.9.3 | Relancer, reconnecter le module | **la carte est retrouvée telle quelle**, sans attendre de réémission | |
| 3.9.4 | Mettre l'app en arrière-plan 10 min, revenir | l'état est intact | |

### 3.10 Mode mixte — réseau et mesh simultanés

| # | Action | Attendu | Résultat |
|---|---|---|---|
| 3.10.1 | A en salle serveur **et** module appairé | les deux chemins actifs | |
| 3.10.2 | Poser un figuré depuis A | il part par les deux chemins | |
| 3.10.3 | B, en mesh seul, le reçoit | | |
| 3.10.4 | C, en serveur seul, le reçoit | | |
| 3.10.5 | Un poste recevant par les deux chemins | **aucun doublon** sur la carte | |
| 3.10.6 | Couper le réseau de A, garder le mesh | la carte continue de vivre par la radio | |

---

## 4. Fiches de relevé

### 4.1 Configuration du banc

| Champ | Valeur |
|---|---|
| Date, lieu | |
| Micrologiciel Meshtastic | |
| Région | |
| **Préréglage** (LongFast, MediumSlow…) | |
| Nombre de modules | |
| Modèle des modules, antenne | |
| Appareils, navigateurs | |
| Version TacQuest (`git rev-parse --short HEAD`) | |

### 4.2 Compteurs de diagnostic

Un relevé par poste, après au moins une heure de session. Le bouton **Copier**
du panneau Diagnostic emporte tout d'un coup, état radio et journal.

| Champ | Poste A | Poste B | Poste C |
|---|---|---|---|
| Trames reçues | | | |
| dont ordres | | | |
| Positions reçues | | | |
| **Trames illisibles** | | | |
| Trames émises | | | |
| dont relais | | | |
| Airtime consommé (%) | | | |
| Trames en attente | | | |
| Trames abandonnées | | | |
| Trous restants | | | |

### 4.3 Portée

| Palier | Distance | Terrain | Figuré transmis | Position reçue | Remarque |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |

### 4.4 Délais observés

| Mesure | Attendu | Observé |
|---|---|---|
| Figuré posé → reçu par le pair, au contact | quelques secondes | |
| Position → visible chez le pair | ≤ 2 min | |
| Rattrapage après rallumage | quelques minutes | |
| Relais par un tiers (§ 3.5) | quelques minutes | |

---

## 5. Confronter les mesures aux estimations

**C'est le point le plus incertain de tout le projet.** Les paramètres radio des
préréglages (`MESH_PRESETS` dans `shared/src/mesh/airtime.ts`) viennent de la
documentation, **pas d'une lecture du module**. Toute l'arithmétique d'airtime —
et donc le gouverneur, et donc la cadence des positions — en dépend.

### Estimations actuelles, préréglage LongFast

| Message | Trame | Temps d'antenne estimé | Trames/heure |
|---|---|---|---|
| `clear` | 23 o | 436 ms | 82 |
| plot ENI | 31 o | 477 ms | 75 |
| figuré de mission | 41 o | 559 ms | 64 |
| position | 44 o | 559 ms | 64 |
| trame pleine | 216 o | 1 870 ms | 19 |

Budget légal EU868 : **36 s d'émission par heure et par appareil**.

### Méthode de confrontation

1. Relever, après une heure pleine de session, le nombre de trames émises et le
   pourcentage d'airtime affiché au diagnostic (fiche § 4.2).
2. Calculer le temps moyen par trame : `airtime_consommé / trames_émises`.
3. Comparer à l'estimation correspondante ci-dessus.

| Mesure | Valeur |
|---|---|
| Trames émises en 1 h | |
| Airtime affiché (%) | |
| Airtime en ms (`% × 360`) | |
| **Temps moyen par trame** | |
| Estimation correspondante | |
| Écart | |

Un écart important signifie que le préréglage réel n'est pas celui supposé. Une
**surestimation freine plus que nécessaire** — c'est le sens sûr de l'erreur, et
ce n'est pas grave. Une **sous-estimation est plus ennuyeuse** : le module
refusera d'émettre avant que le gouverneur ne l'ait anticipé, et des trames
seront perdues sans que l'application le sache.

Si l'écart dépasse 20 %, corriger `MESH_PRESETS` avec les paramètres réels lus
sur le module.

---

## 6. Hors périmètre

Ces points ne sont **pas** à tester : ils ne sont pas implémentés, par décision
documentée dans `docs/mesh/protocol.md` § 8.

| Fonction | Raison |
|---|---|
| Position temps réel à haute fréquence | la cadence serveur de 30 s représenterait 186 % du duty cycle — illégal |
| Transfert de fonds de carte | des mégaoctets à ~1 kbit/s utile ; tuiles à précharger avant sortie |
| Audio | sans objet à ce débit |
| Resynchronisation complète en une opération | hors budget ; le rattrapage est incrémental (§ 3.4) |
| Création de salle avec unicité garantie en mesh | aucune autorité sur un mesh ; salle = canal + PSK |
| Exclusion, clôture administrateur en mesh | idem ; retirer la PSK et changer de canal |
| Pontage serveur → LoRa | volontairement absent : un nœud pontant deviendrait le répéteur de toute une salle |
| Altitude, géocodage, recherche de lieu hors ligne | dépendent d'API HTTP, déjà dégradés proprement |

---

## 7. Après la campagne

1. Copier les diagnostics de chaque poste (bouton **Copier**).
2. Remplir les fiches du § 4.
3. Reporter les écarts du § 5.
4. Consigner tout comportement inattendu, même mineur, avec l'heure : le journal
   du panneau de diagnostic est horodaté et permet de recouper.
