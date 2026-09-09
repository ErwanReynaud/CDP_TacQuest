# syntax=docker/dockerfile:1

# --- Étape build : install complet + build du client (Vite) ---
FROM node:22-slim AS build
WORKDIR /app

# Manifests d'abord : le cache de couches Docker évite de réinstaller à chaque
# changement de code source.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY . .
RUN npm run build   # génère client/dist

# --- Image finale ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# node_modules (avec tsx), sources serveur/shared en TS, et client/dist bâti.
COPY --from=build /app ./
EXPOSE 3000
# Node lancé en PID 1 (pas via npm/npx) pour recevoir SIGTERM directement :
# c'est ce qui déclenche la sauvegarde finale du snapshot à chaque redéploiement.
# `--import tsx` exécute le TypeScript sans étape de compilation serveur.
CMD ["node", "--import", "tsx", "server/src/index.ts"]
