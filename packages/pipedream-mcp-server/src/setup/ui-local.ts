/** Local (development) setup page. DOM is built with textContent only (no innerHTML); no inline style attributes (CSP). */
export function renderLocalPage(nonce: string): string {
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
  [hidden] { display: none !important; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; }
  main { max-width:680px; margin:0 auto; padding:40px 20px 120px; }
  h1 { font-size:22px; margin:0 0 4px; }
  p { margin:0 0 16px; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 16px; margin:0 0 8px; }
  label.pick { display:flex; gap:12px; align-items:flex-start; cursor:pointer; }
  label.pick input { margin-top:4px; }
  .grow { flex:1 1 auto; min-width:0; }
  .card.sel { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
  .id { font-weight:600; overflow-wrap:anywhere; }
  .meta { color:var(--muted); font-size:13px; }
  .keyrow { display:flex; gap:10px; align-items:center; margin:8px 0; }
  .cmd { display:block; padding:9px 11px; border:1px solid var(--line); border-radius:8px; background:transparent; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px; overflow-wrap:anywhere; }
  input[type=password] { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:inherit; font:inherit; letter-spacing:.08em; }
  button.small { padding:7px 12px; font-size:13px; }
  .dup { color:var(--err); }
  .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
  .badge { display:inline-block; margin-left:8px; padding:1px 8px; border-radius:99px; border:1px solid var(--ok); color:var(--ok); font-size:12px; font-weight:600; }
  input[type=search] { width:100%; padding:10px 12px; margin:0 0 12px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:inherit; font:inherit; }
  .bar { position:fixed; left:0; right:0; bottom:0; background:var(--card); border-top:1px solid var(--line); padding:12px 20px; }
  .bar-inner { max-width:680px; margin:0 auto; display:flex; gap:12px; align-items:center; justify-content:space-between; }
  .bar-inner .meta { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
  .bar-inner button { flex:0 0 auto; }
  button { padding:10px 18px; border-radius:8px; border:0; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button[disabled] { opacity:.5; cursor:default; }
  #mvs-error { color:var(--err); min-height:22px; margin-top:8px; }
  .ok { color:var(--ok); font-weight:600; }
  .name { font-weight:600; }
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

  function renderSelect(s) {
    $('mvs-subtitle').textContent = 'Choose the client(s) to install. Names come from the accounts each client connected in Pipedream. Each selected client becomes its own connection in Claude Code. Project ' + s.projectId + ' (' + s.environment + ').';
    const filter = el('input', { type: 'search', id: 'mvs-filter', placeholder: 'Search by name, email, ID or app', autocomplete: 'off' });
    root.append(filter);

    const sameLabel = {};
    s.clients.forEach((c) => { sameLabel[c.label] = (sameLabel[c.label] || 0) + 1; });
    const rows = [];
    const list = el('div', { id: 'mvs-list' });
    s.clients.forEach((c, i) => {
      const cb = el('input', { type: 'checkbox', id: 'mvs-pick-' + i });
      const shortId = c.id.slice(0, 8);
      const apps = c.apps.length ? c.apps.length + ' app' + (c.apps.length === 1 ? '' : 's') + ': ' + c.apps.join(', ') : 'No healthy apps connected';
      const meta = apps + (c.unhealthy ? ' (' + c.unhealthy + ' need reconnect)' : '');
      const others = c.names.slice(1, 4);
      const more = c.names.length - 1 - others.length;
      const title = el('div', { class: 'id' }, el('span', { text: c.label }));
      if (c.installed) title.append(el('span', { class: 'badge', text: 'Installed' }));
      const body = el('div', { class: 'grow' }, title);
      if (others.length) body.append(el('div', { class: 'meta', id: 'mvs-also-' + i, text: 'Also: ' + others.join(', ') + (more > 0 ? ' and ' + more + ' more' : '') }));
      body.append(el('div', { class: 'meta', id: 'mvs-meta-' + i, text: meta }));
      const when = c.lastUpdated ? ' · last updated ' + c.lastUpdated.slice(0, 10) : '';
      body.append(el('div', { class: 'meta', id: 'mvs-activity-' + i, text: c.accounts + ' account' + (c.accounts === 1 ? '' : 's') + when }));
      if (sameLabel[c.label] > 1) body.append(el('div', { class: 'meta dup', id: 'mvs-dup-' + i, text: 'Same name as ' + (sameLabel[c.label] - 1) + ' other client' + (sameLabel[c.label] === 2 ? '' : 's') + ' — check the ID' }));
      body.append(el('div', { class: 'meta mono', id: 'mvs-uid-' + i, title: c.id, text: 'ID ' + shortId + '…' }));
      const row = el('div', { class: 'card', id: 'mvs-client-' + i }, el('label', { class: 'pick', for: 'mvs-pick-' + i }, cb, body));
      rows.push({ row, cb, c, hay: (c.id + ' ' + c.names.join(' ') + ' ' + c.apps.join(' ')).toLowerCase() });
      list.append(row);
    });
    if (!s.clients.length) list.append(el('p', { id: 'mvs-empty', text: 'No clients with connected accounts were found in this project.' }));
    root.append(list);

    const count = el('span', { id: 'mvs-count', class: 'meta', text: '0 selected' });
    const btn = el('button', { id: 'mvs-install', text: 'Install' });
    const update = () => {
      const picked = rows.filter((r) => r.cb.checked);
      rows.forEach((r) => r.row.classList.toggle('sel', r.cb.checked));
      const names = picked.slice(0, 3).map((r) => r.c.label + ' (' + r.c.id.slice(0, 8) + ')').join(', ') + (picked.length > 3 ? ' and ' + (picked.length - 3) + ' more' : '');
      count.textContent = picked.length ? 'Will install: ' + names : '0 selected';
      btn.textContent = picked.length ? 'Install ' + picked.length + (picked.length === 1 ? ' client' : ' clients') : 'Install';
      btn.disabled = picked.length === 0;
    };
    update();
    rows.forEach((r) => r.cb.addEventListener('change', update));
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      rows.forEach((r) => { r.row.hidden = q !== '' && !r.hay.includes(q); });
    });
    btn.addEventListener('click', async () => {
      setErr(''); btn.disabled = true; btn.textContent = 'Installing…';
      try {
        const done = await api('/api/install', { clientIds: rows.filter((r) => r.cb.checked).map((r) => r.c.id) });
        show(done);
      } catch (e) { setErr(e.message); btn.textContent = 'Install'; update(); }
    });
    document.body.append(el('div', { class: 'bar', id: 'mvs-bar' }, el('div', { class: 'bar-inner' }, count, btn)));
  }

  const PROMPT = 'What are the Pipedream integrations ready?';
  let pollTimer = null;
  let cleaning = false;

  function renderKey(s) {
    $('mvs-subtitle').textContent = 'Enter the access key your admin gave you to start.';
    const input = el('input', { type: 'password', id: 'mvs-key-input', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX', autocomplete: 'off', spellcheck: 'false' });
    const btn = el('button', { id: 'mvs-unlock', text: 'Unlock' });
    const go = async () => {
      setErr(''); btn.disabled = true;
      try { await api('/api/unlock', { key: input.value }); await refresh(); }
      catch (e) { setErr(e.message); btn.disabled = false; input.select(); }
    };
    btn.addEventListener('click', go);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    root.append(el('div', { class: 'card', id: 'mvs-key-card' }, el('label', { for: 'mvs-key-input', class: 'name', text: 'Access key' }), el('div', { class: 'meta', text: 'Typed here only; it is never written to disk or to your Claude Code chat.' }), el('div', { class: 'keyrow', id: 'mvs-key-row' }, el('div', { class: 'grow' }, input), btn)));
    if (s.error) setErr(s.error);
    input.focus();
  }

  function renderLoading(s) {
    $('mvs-subtitle').textContent = 'Key accepted. Reading clients from Pipedream…';
    root.append(el('div', { class: 'card', id: 'mvs-loading' }, el('div', { class: 'name', text: 'Loading clients' }), el('div', { class: 'meta', id: 'mvs-progress', text: s.progress + ' accounts read' })));
    pollTimer = setTimeout(refresh, 1000);
  }

  function copyButton(id, text) {
    const b = el('button', { id, text: 'Copy', class: 'small' });
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Select and copy'; }
    });
    return b;
  }

  function renderDone(s) {
    const bar = $('mvs-bar'); if (bar) bar.remove();
    $('mvs-title').textContent = 'Installed';
    if (s.needsCleanup) {
      $('mvs-subtitle').textContent = 'Finishing up…';
      if (!cleaning) {
        cleaning = true;
        api('/api/cleanup', {}).then(show).catch((e) => { cleaning = false; setErr(e.message); });
      }
      return;
    }
    $('mvs-subtitle').textContent = 'You can close this tab.';
    (s.results || []).forEach((r, i) => {
      root.append(el('div', { class: 'card', id: 'mvs-result-' + i },
        el('div', { class: 'name', text: r.name }),
        el('div', { class: 'meta', text: r.ok ? 'Registered with Claude Code.' : 'Run this in your terminal: ' + r.manualCommand })));
    });
    const cmd = 'claude "' + PROMPT + '"';
    root.append(el('div', { class: 'card', id: 'mvs-next' },
      el('div', { class: 'name', text: 'Next: start a new Claude Code session' }),
      el('div', { class: 'meta', text: 'The new connection loads when Claude Code starts. Close this tab, then run this in a terminal:' }),
      el('div', { class: 'keyrow', id: 'mvs-cmd-row' }, el('code', { class: 'cmd grow', id: 'mvs-cmd', text: cmd }), copyButton('mvs-copy-cmd', cmd)),
      el('div', { class: 'meta', text: 'Or open Claude Code as usual and ask:' }),
      el('div', { class: 'keyrow', id: 'mvs-prompt-row' }, el('code', { class: 'cmd grow', id: 'mvs-prompt', text: PROMPT }), copyButton('mvs-copy-prompt', PROMPT))));
    // Browsers only let a script close tabs it opened, so this is best effort.
    setTimeout(() => { window.close(); }, 8000);
  }

  async function refresh() { show(await api('/api/state')); }

  function show(s) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    setErr('');
    root.replaceChildren();
    if (s.stage === 'key') renderKey(s);
    else if (s.stage === 'loading') renderLoading(s);
    else if (s.stage === 'select') renderSelect(s);
    else renderDone(s);
  }
  refresh().catch((e) => setErr(e.message));
})();
</script>
</body>
</html>`;
}
