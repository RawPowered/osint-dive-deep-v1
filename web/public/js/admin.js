const base = location.pathname.replace(/\/$/, '') || '';

function wireNav() {
  const paths = {
    keys: base + '/keys',
    docs: base + '/docs',
    sentinel: base + '/sentinel',
    connections: base + '/connections',
    crm: base + '/crm-integrations',
    owl: base + '/owl',
    eagle: base + '/eagle',
    song: base + '/song',
    hawk: base + '/hawk',
    parrot: base + '/parrot',
    divedeep: base + '/divedeep',
  };
  document.getElementById('navKeys').href = paths.keys;
  document.getElementById('navDocs').href = paths.docs;
  document.getElementById('navSentinel').href = paths.sentinel;
  document.getElementById('navConn').href = paths.connections;
  document.getElementById('navCrm').href = paths.crm;
  document.getElementById('navOwl').href = paths.owl;
  document.getElementById('navEagle').href = paths.eagle;
  document.getElementById('navSong').href = paths.song;
  document.getElementById('navHawk').href = paths.hawk;
  document.getElementById('navParrot').href = paths.parrot;
  document.getElementById('navDiveDeep').href = paths.divedeep;
  document.getElementById('cardKeys').href = paths.keys;
  document.getElementById('cardDocs').href = paths.docs;
  document.getElementById('cardSentinel').href = paths.sentinel;
  document.getElementById('cardConn').href = paths.connections;
  document.getElementById('cardCrm').href = paths.crm;
  document.getElementById('cardOwl').href = paths.owl;
  document.getElementById('cardEagle').href = paths.eagle;
  document.getElementById('cardSong').href = paths.song;
  document.getElementById('cardHawk').href = paths.hawk;
  document.getElementById('cardParrot').href = paths.parrot;
  document.getElementById('cardDiveDeep').href = paths.divedeep;
}

async function load() {
  wireNav();
  const me = await fetch(base + '/me', { headers: { Accept: 'application/json' } });
  if (!me.ok) {
    window.location.href = base + '/login?next=' + encodeURIComponent(base);
    return;
  }
  const data = await me.json();
  document.getElementById('who').textContent = data.admin.username;
  document.getElementById('account').textContent =
    data.admin.username + ' · role: ' + data.admin.role;
}

document.getElementById('logout').onclick = async (e) => {
  e.preventDefault();
  await fetch(base + '/logout', { method: 'POST' });
  window.location.href = base + '/login';
};

load();
