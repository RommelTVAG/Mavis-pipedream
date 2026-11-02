/** Single-page setup UI served on the loopback server. DOM is built with textContent only (no innerHTML). */
export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="en" id="mvs-html">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAVIS setup</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --fg:#14151a; --bg:#f6f7f9; --card:#fff; --line:#dfe2e8; --muted:#5d6472; --accent:#3b5bfd; --ok:#17803d; --err:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eceef3; --bg:#101218; --card:#181b23; --line:#2a2f3b; --muted:#98a1b3; --accent:#7b93ff; --ok:#4cc57a; --err:#ff7b72; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; }
  main { max-width:640px; margin:0 auto; padding:40px 20px 80px; }
  h1 { font-size:22px; margin:0 0 4px; }
  p { margin:0 0 16px; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin:0 0 12px; }
  .row { display:flex; gap:10px; align-items:center; }
  .row > * { flex:0 0 auto; } .row > .grow { flex:1 1 auto; min-width:0; }
  label.pick { display:flex; gap:12px; align-items:center; cursor:pointer; }
  input[type=text] { width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  button { padding:9px 16px; border-radius:8px; border:0; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button[disabled] { opacity:.5; cursor:default; }
  .chip { display:inline-block; padding:2px 9px; margin:0 6px 6px 0; border-radius:99px; border:1px solid var(--line); font-size:13px; }
  .chip.bad { color:var(--err); border-color:var(--err); }
  .mt { margin-top:10px; }
  .name { font-weight:600; }
  .muted { color:var(--muted); font-size:13px; }
  #mvs-error { color:var(--err); min-height:22px; margin-top:8px; }
  .warn { border-color:var(--err); }
  .ok { color:var(--ok); font-weight:600; }
</style>
</head>
<body id="mvs-body">
<main id="mvs-main">
  <h1 id="mvs-title">MAVIS setup</h1>
  <p id="mvs-subtitle">Loading…</p>
  <div id="mvs-root"></div>
  <div id="mvs-error" role="alert"></div>
</main>
<script nonce="${nonce}">
(() => {
  const $ = (id) => document.getElementById(id);
  const root = $('mvs-root');
  const setErr = (m) => { $('mvs-error').textContent = m || ''; };

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Request failed');
    return data;
  }
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) { if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }
    for (const kid of kids) n.append(kid);
    return n;
  }
  function guarded(btn, fn) {
    btn.addEventListener('click', async () => {
      setErr(''); btn.disabled = true;
      try { await fn(); } catch (e) { setErr(e.message); } finally { btn.disabled = false; }
    });
  }

  function renderSelect(s) {
    $('mvs-subtitle').textContent = 'Choose the clients you will work with on this computer. You can pick several.';
    const boxes = [];
    s.allowed.forEach((c, i) => {
      const cb = el('input', { type: 'checkbox', id: 'mvs-pick-' + i });
      boxes.push([cb, c]);
      root.append(el('div', { class: 'card', id: 'mvs-allowed-' + i }, el('label', { class: 'pick', for: 'mvs-pick-' + i }, cb, el('span', { class: 'name', text: c.name }))));
    });
    root.append(el('p', { class: 'muted', id: 'mvs-lock-note', text: 'Your choice is locked when you finish setup. Adding a client later needs a new setup code from your admin.' }));
    const go = el('button', { id: 'mvs-continue', text: 'Continue' });
    guarded(go, async () => {
      const ids = boxes.filter(([cb]) => cb.checked).map(([, c]) => c.id);
      if (!ids.length) throw new Error('Pick at least one client.');
      await api('/api/select', { clientIds: ids });
      await refresh();
    });
    root.append(go);
  }

  function renderConnect(s) {
    $('mvs-subtitle').textContent = s.mode === 'enroll'
      ? 'Connect each client\\'s apps. Type an app name (like slack or gmail) and sign in on the Pipedream page.'
      : 'Connect more apps for your locked clients.';
    s.selected.forEach((c, i) => {
      const chips = el('div', { id: 'mvs-apps-' + i });
      if (!c.apps.length) chips.append(el('span', { class: 'muted', text: 'No apps connected yet.' }));
      for (const a of c.apps) chips.append(el('span', { class: 'chip' + (a.healthy ? '' : ' bad'), text: a.appName + (a.healthy ? '' : ' (needs reconnect)') }));
      const input = el('input', { type: 'text', id: 'mvs-app-' + i, placeholder: 'App, e.g. slack', autocomplete: 'off' });
      const btn = el('button', { id: 'mvs-connect-' + i, text: 'Connect app' });
      guarded(btn, async () => {
        const { url } = await api('/api/connect', { clientId: c.id, app: input.value });
        window.location.href = url;
      });
      root.append(el('div', { class: 'card', id: 'mvs-client-' + i },
        el('div', { class: 'name', text: c.name }), chips,
        el('div', { class: 'row mt' }, el('div', { class: 'grow' }, input), btn)));
    });

    if (s.mode === 'enroll') {
      const names = s.selected.map((c) => c.name).join(', ');
      const lock = el('input', { type: 'text', id: 'mvs-lock-input', placeholder: 'Type ' + s.lockPhrase, autocomplete: 'off' });
      const fin = el('button', { id: 'mvs-finish', text: 'Finish and lock' });
      guarded(fin, async () => { show(await api('/api/finish', { confirm: lock.value.trim() })); });
      root.append(el('div', { class: 'card warn', id: 'mvs-finish-card' },
        el('div', { class: 'name', text: 'Finish and lock' }),
        el('p', { text: 'This install will be limited to: ' + names + '. This cannot be changed afterwards. Type ' + s.lockPhrase + ' to confirm.' }),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, lock), fin)));
    } else {
      const done = el('button', { id: 'mvs-done', text: 'Done' });
      guarded(done, async () => { show(await api('/api/finish', { confirm: '' })); });
      root.append(done);
    }
  }

  function renderDone(s) {
    $('mvs-title').textContent = 'All set';
    $('mvs-subtitle').textContent = 'You can close this tab and go back to your terminal.';
    root.append(el('p', { class: 'ok', id: 'mvs-done-msg', text: 'Restart Claude Code to load the new connections.' }));
    (s.results || []).forEach((r, i) => {
      root.append(el('div', { class: 'card', id: 'mvs-result-' + i },
        el('div', { class: 'name', text: r.name }),
        el('div', { class: 'muted', text: r.ok ? 'Registered with Claude Code.' : 'Run this in your terminal: ' + r.manualCommand })));
    });
  }

  async function refresh() { show(await api('/api/state')); }
  function show(s) {
    root.replaceChildren();
    if (s.stage === 'select') renderSelect(s);
    else if (s.stage === 'connect') renderConnect(s);
    else renderDone(s);
  }
  refresh().catch((e) => setErr(e.message));
})();
</script>
</body>
</html>`;
}

export function renderCallbackPage(nonce: string): string {
  return `<!doctype html><html lang="en" id="mvs-cb-html"><head><meta charset="utf-8"><title>Returning to setup</title>
<meta http-equiv="refresh" content="1;url=/">
<style nonce="${nonce}">body { font: 16px system-ui, sans-serif; margin: 40px; }</style></head>
<body id="mvs-cb-body"><p id="mvs-cb-msg">Back to setup…</p></body></html>`;
}
