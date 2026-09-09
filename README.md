# TacticalQuest

Carte tactique collaborative (PWA), pensée « carte d'abord » : l'application
s'ouvre directement sur la carte en **mode solo** — géolocalisation, fonds IGN,
quadrillage, outils de tracé et figurés de mission, sans aucun compte ni salle.
Le bouton **Collab** permet ensuite de créer ou rejoindre une **salle éphémère**
(code à 5 caractères lisible à la radio) : chacun rejoint avec un indicatif,
les positions GPS se partagent en temps réel et tous les figurés (tracés,
plots, missions) sont diffusés au groupe — le tout fonctionne même en réseau
dégradé.

- **Auto-hébergé** : un seul process Node, aucune dépendance cloud, les données
  ne transitent par aucun tiers.
- **Salles éphémères** : en mémoire serveur (snapshot périodique sur disque),
  sans comptes. TTL glissant : une salle vit tant qu'on s'y connecte et meurt
  **24 h après la dernière connexion** ; un membre déconnecté reste visible
  (grisé) 24 h.
- **Résilient hors-ligne** : tuiles mises en cache pour les zones blanches ;
  ajouts/suppressions de figurés faits sans réseau, synchronisés à la
  reconnexion. PWA installable (page d'installation guidée sur mobile).
- **Compatibilité maximale** : Leaflet (pas de WebGL requis), cible es2017,
  vanilla TypeScript sans framework — pensé pour de vieux Android.

## Fonctionnalités

| Domaine | Détail |
|---|---|
| Mode solo | Toute la carte sans salle : figurés persistés en local (survivent à la fermeture) ; en rejoignant une salle, l'app propose de les **importer** pour les partager |
| Positions | Soi-même en point GPS bleu + cercle de précision (contour), coéquipiers en points verts étiquetés de leur indicatif (grisés si déconnectés) |
| Fonds de carte | **Sat IGN** (ortho 20 cm, défaut), **Sat Esri** (secours mondial), **IGN 25** (carte topo 1:25 000), **Plan IGN** v2, **Topo OSM** — les deux « Sat » portent une surcouche routes/chemins visible sous canopée |
| Quadrillage | Grille kilométrique UTM (celle du MGRS) avec **numéros de km** sur la colonne et la ligne centrales ; gris blanc sur imagerie, noir sur carte ; désactivable dans le tiroir |
| Coordonnées | Réticule central fixe + lecture du centre (formats **MGRS / UTM / géo** commutables, altitude IGN) ; « aller à » des coordonnées saisies ; **recherche de lieu** (géocodage IGN : communes, adresses, lieux-dits) |
| Outils locaux | Règle (distance cumulée), boussole « cap en haut », **rapporteur** (azimuts en degrés et millièmes depuis le réticule) |
| Tracés partagés | Liserés (nom + figuré d'échelon APP-6), flèches/axes, **box/zones** nommées ; origine sous le réticule, aperçu élastique ; suppression/édition par tous |
| Plots | **ENI** (losange rouge APP-6 + texte) et **points nommés** (rond de couleur) sous le réticule ; popup avec coordonnées, distance jusqu'à moi, Modifier/Supprimer |
| Missions | Panneau « Tac » : 15 figurés de mission doctrinaux **section/groupe** (offensives, défensives, sûreté — S'EMP, APP, NEUT, DEF, TEN, ECL, RECO, COUV…) tracés comme des flèches |
| Comms | Chat de salle avec accusés de lecture (coche façon WhatsApp), notifications toast + vibration, compteur de non-lus |
| Réseau dégradé | Reconnexion auto (Socket.IO), rejoin transparent, file d'attente des ordres hors-ligne (badge d'éléments non synchronisés) |
| Terrain / batterie | Position échantillonnée en **basse précision** à cadence lente : un point à l'arrivée puis **1 point / 30 s** au premier plan (GPS éteint entre deux) ; réception des positions bufferisée (un rendu / 30 s) |

## Développement

```bash
npm install
npm run dev        # serveur :3000 + Vite :5173 (proxy /socket.io, HMR)
```

Ouvrir http://localhost:5173 dans deux onglets (dont un en navigation privée)
pour simuler deux membres. La géolocalisation fonctionne sur `localhost` sans
TLS ; pour simuler un déplacement : DevTools → ⋮ → More tools → **Sensors** →
Location. Pour simuler une coupure : DevTools → Network → Offline.

```bash
npm test           # tests unitaires (serveur + client)
npm run typecheck
node scripts/e2e.mjs   # scénario protocole bout-en-bout (serveur lancé requis)
```

### Test sur mobile sans déployer

- **Câble USB (Android)** : `adb reverse tcp:3000 tcp:3000` puis ouvrir
  `http://localhost:3000` sur le téléphone (exemption HTTPS de localhost).
- **Tailscale (iOS/Android)** : `tailscale serve --bg --https=443 localhost:3000`
  → URL `https://<machine>.<tailnet>.ts.net` avec certificat valide, rien à
  installer sur le téléphone. (Pour le dev Vite : pointer vers `:5173` ;
  `allowedHosts: ['.ts.net']` est déjà configuré.)

## Production

### Fly.io (déploiement actuel)

Le dépôt contient `fly.toml` (machine always-on, healthcheck `/healthz`) et un
`Dockerfile` multi-stage ; le push sur `main` **déploie automatiquement**
(workflow `.github/workflows/fly-deploy.yml`, secret `FLY_API_TOKEN`).

L'état des salles vit en mémoire mais est **snapshotté toutes les 10 s** sur un
volume (`[mounts]` `tq_data` → `/data`, env `DATA_DIR`/`SNAPSHOT_PATH`) et
rechargé au boot : un redéploiement ou un crash ne perd au pire que ~10 s.
Une sauvegarde finale part sur SIGTERM — d'où le `CMD` Docker en Node PID 1
(via npm, le signal ne serait pas transmis). Mise en place initiale :

```bash
fly launch --no-deploy
fly volumes create tq_data --region cdg --size 1
fly secrets set ADMIN_CODE_HASH=<hash>   # cf. console d'administration
fly deploy
```

### Auto-hébergement classique

```bash
npm install
npm run build      # construit client/dist
npm start          # sert le client + WebSocket sur :3000 (PORT pour changer)
```

TLS obligatoire hors localhost (géolocalisation et service worker exigent
HTTPS). Utiliser Caddy devant le port 3000 (voir `Caddyfile`) :

- **VPS + domaine** : renseigner le domaine dans le Caddyfile, `caddy run` —
  certificat Let's Encrypt automatique.
- **Laptop de terrain / LAN sans internet** : bloc `tls internal`.
  ⚠️ Piège classique : installer le certificat racine de Caddy
  (`~/.local/share/caddy/pki/authorities/local/root.crt`) **une fois sur chaque
  téléphone** (Android : Paramètres → Sécurité → Installer un certificat → CA),
  sinon ni la géolocalisation ni le service worker ne fonctionneront.
  Alternative : `mkcert -install` + certificat pour l'IP LAN.

### Console d'administration

Une page `/admin` permet de lister les salles actives, les **terminer**,
**relancer** le compte à rebours d'une salle vide (24 h) et **exclure** un
membre. Elle est protégée par un code
dont seul le **hash sha256** vit côté serveur, dans le secret `ADMIN_CODE_HASH` :

```bash
# Calculer le hash d'un code (ou en générer un aléatoire sans argument) :
node scripts/admin-hash.mjs "mon-code-secret"

# En production (Fly) :
fly secrets set ADMIN_CODE_HASH=<hash>
# En local :
ADMIN_CODE_HASH=<hash> npm start
```

Sans ce secret, toute la zone `/admin` renvoie 503 (désactivée). Le code saisi
sur la page n'est jamais stocké côté serveur ; il transite en
`Authorization: Bearer` sur chaque appel et est comparé au hash à temps constant.
La page est servie hors du build PWA (le service worker ignore `/admin`).
Terminer une salle ou exclure un membre renvoie les clients concernés en solo
(`room_closed` `closed`/`kicked`).

Durcissements :

- **HTTPS imposé au niveau applicatif** : toute requête `/admin` non chiffrée est
  refusée (403). Détection via `x-forwarded-proto` (posé par Fly/Caddy) ;
  `localhost` est toléré en dev, et `ADMIN_ALLOW_INSECURE=1` lève la contrainte
  si vraiment nécessaire.
- **Verrou anti brute-force** : au-delà de `ADMIN_AUTH_MAX_FAILS` (8) échecs par
  IP sur 15 min, l'IP est bloquée (429 + `Retry-After`) jusqu'à expiration de la
  fenêtre — un succès remet le compteur à zéro. Sur Fly, l'IP réelle vient de
  l'en-tête non usurpable `Fly-Client-IP`. ⚠️ Conséquence assumée : huit fautes
  de frappe verrouillent la console 15 min — d'où l'intérêt de coller le code
  généré plutôt que de le retaper.

Le code lui-même doit être à **haute entropie** : le hash stocké est un sha256 nu
(non salé), donc un code faible serait cassable hors-ligne s'il fuyait. Utiliser
`node scripts/admin-hash.mjs` sans argument génère un code aléatoire fort.

## Architecture

```
shared/   protocole Socket.IO typé + constantes (source de vérité unique)
server/   Express + Socket.IO : salles en mémoire + snapshot disque, GC,
          rate limiting, console admin
client/   Vanilla TS + Leaflet + milsymbol ; PWA (manifest + sw.js)
```

**Modèle d'ordres.** Tracés, plots, messages de chat et accusés de lecture
passent tous par une enveloppe générique `OrderMessage`
(`shared/src/protocol.ts`, kinds `graphic` / `waypoint` / `text` / `remove` /
`ack`). Le serveur la **relaie sans l'interpréter** : valider la taille,
pousser dans le ring buffer `recentOrders` (livré aux retardataires), diffuser.
Un nouveau type d'ordre est donc un changement **client uniquement** — les
figurés de mission (champ `style.mission`, opaque pour le serveur) en sont un
exemple. **Tout figuré transmis est affiché tel quel par tous les membres** :
pas de filtrage local à la réception — un tracé qu'un membre voit, tous le
voient (c'était le rôle des calques, retirés pour cette raison).

**Corollaire sécurité** : comme le serveur ne valide pas la sémantique des
payloads (relais opaque), le client traite tout ordre reçu comme **non fiable**.
Les textes sont échappés (`escapeHtml`) et les champs réinjectés dans des
attributs HTML sont assainis : `color` passe par `safeColor` (hex ou nom
alphabétique seulement — bloque l'évasion d'attribut / l'injection CSS) et le
`sidc` d'un plot est validé contre `SIDC_REGEX` avant milsymbol. Sans cela, un
participant malveillant pourrait injecter du HTML/JS rendu chez tous les autres
(XSS stocké). En défense en profondeur, le serveur pose une **CSP** stricte
(`script-src 'self'`, aucun inline JS) et les en-têtes `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy` (cf. `server/src/index.ts`) — la console
`/admin`, auto-suffisante avec son JS/CSS en ligne, porte sa propre CSP.

**Anti-abus serveur.** Les points d'entrée sont rate-limités par IP : création
de salle (`ROOM_CREATE_PER_IP_PER_HOUR`), verrou anti brute-force du code de
salle sur les join en échec (`JoinRateLimiter`) et du code admin
(`AdminAuthLimiter`), et throttle des ordres par membre contre le flood
(`RoomManager.acceptOrder`, `ORDER_MAX_PER_WINDOW`) — un ordre au-delà du quota
est refusé (`RATE_LIMITED`, transitoire : conservé en file et retenté côté
client). L'IP réelle est résolue derrière le proxy via `Fly-Client-IP` (non
usurpable), avec repli `X-Forwarded-For` (cf. `server/src/clientIp.ts`) : sans
cela, tout le trafic derrière Fly/Caddy partagerait une seule IP interne et les
compteurs deviendraient inopérants.

Côté client, les ordres sont appliqués de façon **optimiste** (visibles
immédiatement). En salle, ils partent dans une file persistée
(`sessionStorage`) vidée à chaque (re)connexion après réconciliation avec le
snapshot serveur ; en solo, ils sont persistés en `localStorage`
(`client/src/soloOrders.ts`) et rechargés à chaque démarrage.

Modules clients notables : `map/missionCatalog.ts` (catalogue **pur** des
figurés de mission, testé — séparé du rendu Leaflet `map/missions.ts`, vitest
tournant en env node), `map/grid.ts` (quadrillage UTM, conversion inverse `fromUtm` dans `coords.ts`),
`geocode.ts` (recherche de lieu IGN).

### Réglages

Limites et délais (membres/salle, période de grâce, TTL, throttles, plafond du
cache de tuiles…) : `shared/src/constants.ts`.

## Limites connues

- **Veille / arrière-plan** : la position n'est suivie que **page au premier
  plan**. Écran verrouillé ou onglet en arrière-plan, les navigateurs mobiles
  gèlent les timers et le GPS : aucun point n'est envoyé. La grâce maintient le
  dernier point connu côté serveur, et l'échantillonnage reprend au retour au
  premier plan. Un wrapper natif (Capacitor) serait la voie si le besoin d'un
  vrai suivi en arrière-plan revient.
- **Fond « IGN 25 »** : servi par l'endpoint privé de la Géoplateforme avec la
  clé partagée historique `ign_scan_ws` (celle des tutoriels IGN) — elle peut
  être révoquée un jour ; les autres fonds ne dépendent d'aucune clé.
- **Couverture IGN** : ortho, Plan et IGN 25 couvrent France + DOM ; ailleurs,
  basculer sur « Sat Esri » ou « Topo OSM ».
- **Cache de tuiles** : plafonné (~2000 tuiles, éviction FIFO) ; Safari peut
  purger le stockage d'un site non installé après ~7 jours — installer la PWA
  sur l'écran d'accueil pour la persistance.
