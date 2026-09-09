// Page d'administration servie en clair par admin.ts (hors build Vite, donc
// hors service worker / PWA). Auto-suffisante : un seul fichier HTML+CSS+JS,
// aucune dépendance. Le code admin saisi est gardé en sessionStorage et envoyé
// en `Authorization: Bearer …` sur chaque appel à /admin/api/*.

export const ADMIN_HTML = /* html */ `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>TacticalQuest — Admin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px;
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    background: #11140f; color: #d6dac8; font-size: 14px;
  }
  h1 { font-size: 16px; margin: 0 0 12px; letter-spacing: 1px; }
  .muted { color: #8c917f; }
  .err { color: #ff8779; min-height: 18px; margin: 6px 0; }
  button {
    font: inherit; cursor: pointer; color: #d6dac8;
    background: #2a2f22; border: 1px solid #444b35; border-radius: 6px;
    padding: 6px 10px;
  }
  button:hover { background: #353c29; }
  button.danger { border-color: #6b3530; color: #ff8779; }
  button.danger:hover { background: #3a2420; }
  input {
    font: inherit; color: #d6dac8; background: #1a1e15;
    border: 1px solid #444b35; border-radius: 6px; padding: 8px 10px;
  }
  #login { max-width: 360px; }
  #login input { width: 100%; margin: 8px 0; }
  .room {
    border: 1px solid #333a26; border-radius: 8px; padding: 12px;
    margin: 10px 0; background: #181c12;
  }
  .room-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .code { font-size: 18px; font-weight: bold; letter-spacing: 2px; }
  .badge {
    background: #222719; border: 1px solid #3a4129; border-radius: 4px;
    padding: 2px 6px; font-size: 12px;
  }
  .room-actions { margin-left: auto; display: flex; gap: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #262c1c; }
  th { color: #8c917f; font-weight: normal; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
  .on { background: #6ad06a; } .off { background: #6b6f5e; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
  .hidden { display: none; }
</style>
</head>
<body>
<h1>TACTICALQUEST · ADMIN</h1>

<section id="login">
  <p class="muted">Saisis le code d'administration.</p>
  <input id="code" type="password" autocomplete="off" placeholder="code admin" />
  <button id="login-btn">Entrer</button>
  <div class="err" id="login-err"></div>
</section>

<section id="console" class="hidden">
  <div class="toolbar">
    <button id="refresh">Rafraîchir</button>
    <button id="logout">Déconnexion</button>
    <span class="muted" id="meta"></span>
  </div>
  <div class="err" id="err"></div>
  <div id="rooms"></div>
</section>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = 'tq-admin-code';
  let code = sessionStorage.getItem(KEY) || '';

  async function api(path, opts = {}) {
    const res = await fetch('/admin/api' + path, {
      ...opts,
      headers: { 'Authorization': 'Bearer ' + code, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (res.status === 401) { const e = new Error('unauthorized'); e.code = 401; throw e; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.status === 204 ? null : res.json();
  }

  function fmtDuration(ms) {
    if (ms <= 0) return 'expiré';
    const m = Math.round(ms / 60000);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    return h + ' h ' + (m % 60) + ' min';
  }
  function fmtAge(ts) { return fmtDuration(Date.now() - ts).replace('expiré', '0 min'); }

  function showConsole() { $('login').classList.add('hidden'); $('console').classList.remove('hidden'); refresh(); }
  function showLogin(msg) {
    $('console').classList.add('hidden'); $('login').classList.remove('hidden');
    $('login-err').textContent = msg || '';
  }

  function render(data) {
    const rooms = data.rooms;
    $('meta').textContent = rooms.length + ' salle(s) · ' + new Date(data.now).toLocaleTimeString('fr-FR');
    if (!rooms.length) { $('rooms').innerHTML = '<p class="muted">Aucune salle active.</p>'; return; }
    $('rooms').innerHTML = rooms.map((r) => {
      const members = r.members.map((m) =>
        '<tr><td><span class="dot ' + (m.connected ? 'on' : 'off') + '"></span></td>' +
        '<td>' + esc(m.callsign) + (m.isLeader ? ' <span class="badge">CHEF</span>' : '') + '</td>' +
        '<td class="muted">' + fmtAge(m.lastSeen) + '</td>' +
        '<td><button class="danger" data-kick="' + r.code + '|' + m.id + '">Kick</button></td></tr>'
      ).join('');
      return '<div class="room"><div class="room-head">' +
        '<span class="code">' + r.code + '</span>' +
        '<span class="badge">' + r.connectedCount + '/' + r.memberCount + ' connectés</span>' +
        '<span class="badge">âge ' + fmtAge(r.createdAt) + '</span>' +
        '<span class="badge">' + (r.expiresInMs === null ? 'occupée — n\\'expire pas' : 'expire dans ' + fmtDuration(r.expiresInMs)) + '</span>' +
        '<span class="badge">' + r.orderCount + ' ordres</span>' +
        '<span class="room-actions">' +
          (r.expiresInMs === null ? '' : '<button data-extend="' + r.code + '">Rallonger 24 h</button>') +
          '<button class="danger" data-close="' + r.code + '">Terminer</button>' +
        '</span></div>' +
        (r.members.length
          ? '<table><thead><tr><th></th><th>Indicatif</th><th>Vu</th><th></th></tr></thead><tbody>' + members + '</tbody></table>'
          : '<p class="muted">Salle vide.</p>') +
        '</div>';
    }).join('');
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function refresh() {
    $('err').textContent = '';
    try { render(await api('/rooms')); }
    catch (e) { if (e.code === 401) { sessionStorage.removeItem(KEY); showLogin('Session expirée, reconnecte-toi.'); } else $('err').textContent = String(e.message || e); }
  }

  $('rooms').addEventListener('click', async (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLButtonElement)) return;
    try {
      if (t.dataset.close) { if (!confirm('Terminer la salle ' + t.dataset.close + ' ?')) return; await api('/rooms/' + t.dataset.close + '/close', { method: 'POST' }); }
      else if (t.dataset.extend) { await api('/rooms/' + t.dataset.extend + '/extend', { method: 'POST' }); }
      else if (t.dataset.kick) { const [c, id] = t.dataset.kick.split('|'); if (!confirm('Exclure ce membre ?')) return; await api('/rooms/' + c + '/kick', { method: 'POST', body: JSON.stringify({ memberId: id }) }); }
      else return;
      refresh();
    } catch (e) { $('err').textContent = String(e.message || e); }
  });

  $('login-btn').addEventListener('click', async () => {
    code = $('code').value.trim();
    if (!code) return;
    try { await api('/rooms'); sessionStorage.setItem(KEY, code); $('code').value = ''; showConsole(); }
    catch (e) { showLogin(e.code === 401 ? 'Code refusé.' : 'Erreur : ' + (e.message || e)); }
  });
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });
  $('refresh').addEventListener('click', refresh);
  $('logout').addEventListener('click', () => { sessionStorage.removeItem(KEY); code = ''; showLogin(''); });

  if (code) api('/rooms').then(showConsole).catch(() => showLogin(''));
})();
</script>
</body>
</html>`;
