#!/usr/bin/env node
// Calcule le hash sha256 d'un code d'administration, à mettre dans le secret
// serveur ADMIN_CODE_HASH. La page /admin demandera le code en clair ; seul ce
// hash vit côté serveur.
//
// Usage :
//   node scripts/admin-hash.mjs "mon-code-secret"
//   node scripts/admin-hash.mjs            # génère un code aléatoire fort
//
// Puis :
//   fly secrets set ADMIN_CODE_HASH=<hash>
//   # ou en local :  ADMIN_CODE_HASH=<hash> npm run start -w server

import { createHash, randomBytes } from 'node:crypto';

let code = process.argv[2];
if (!code) {
  // Code aléatoire lisible (base32 sans ambiguïté), ~100 bits d'entropie.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  console.log('Code généré (à conserver) :', code);
}

const hash = createHash('sha256').update(code, 'utf8').digest('hex');
console.log('ADMIN_CODE_HASH =', hash);
