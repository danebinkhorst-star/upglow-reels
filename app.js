/* Reels — phone app. Data lives in Supabase (live via realtime); everything here is owner-only via RLS. */
(() => {
  const C = window.REELS_CONFIG || {};
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const view = $('#view');
  let sb, tab = 'ideas', data = { ideas: [], versions: [], clips: [], taste: [], perf: [], results: [], status: [], metrics: [], history: [] }, signed = {}, skipping = null, busy = false, selReel = null;

  // theme
  try { if (localStorage.getItem('dark') === '1') document.documentElement.setAttribute('data-dark', ''); } catch (e) {}
  $('#theme').onclick = () => { const r = document.documentElement; r.toggleAttribute('data-dark'); try { localStorage.setItem('dark', r.hasAttribute('data-dark') ? '1' : '0'); } catch (e) {} };

  function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 1800); }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(`${what} copied`); } catch (_) { toast('Copy failed, select the text'); } ta.remove(); }
  }
  async function url(path) {
    if (!path) return '';
    const hit = signed[path]; if (hit && hit.exp > Date.now()) return hit.url;
    const { data: d } = await sb.storage.from('reels').createSignedUrl(path, 3600);
    if (d?.signedUrl) signed[path] = { url: d.signedUrl, exp: Date.now() + 3300e3 };
    return d?.signedUrl || '';
  }

  if (!C.supabaseUrl || !window.supabase) { view.innerHTML = `<section class="card"><h2>Not set up yet</h2><p class="sub">The app's connection details are missing.</p></section>`; return; }
  sb = window.supabase.createClient(C.supabaseUrl, C.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  sb.auth.onAuthStateChange((_e, session) => { setTimeout(() => session ? start() : login(), 0); });
  sb.auth.getSession().then(({ data: d }) => d.session ? start() : login());

  function login() {
    $('#tabs').hidden = true; $('#live').hidden = true;
    view.innerHTML = `<section class="card"><h2>Log in</h2><p class="sub">We email you a code. Type it here. Ignore the link in the mail.</p>
      <form id="lf" style="display:grid;gap:10px"><label for="em" class="sub">Email</label><input id="em" type="email" required autocomplete="email" value="${esc(C.owner || '')}"><button class="btn primary">Send code</button></form>
      <form id="cf" hidden style="display:grid;gap:10px"><label for="cd" class="sub">Code from the email</label><input id="cd" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" required style="width:100%;border:1px solid var(--line);border-radius:14px;padding:12px 14px;font:inherit;font-size:20px;letter-spacing:.2em;background:var(--glass-2);color:var(--ink)"><button class="btn primary">Log in</button></form></section>`;
    $('#lf').onsubmit = async e => {
      e.preventDefault();
      const { error } = await sb.auth.signInWithOtp({ email: $('#em').value.trim(), options: { shouldCreateUser: false } });
      if (error) return toast(error.message);
      toast('Code sent'); $('#cf').hidden = false; $('#cd').focus();
    };
    $('#cf').onsubmit = async e => {
      e.preventDefault();
      const { error } = await sb.auth.verifyOtp({ email: $('#em').value.trim(), token: $('#cd').value.trim(), type: 'email' });
      if (error) toast(error.message);
    };
  }

  // refresh: header button, pull-down, and auto on return to the app
  async function refresh() { if (!started) return; const b = $('#refresh'); b && b.classList.add('spin'); try { await load(); toast('Updated'); } finally { b && b.classList.remove('spin'); } }
  (() => {
    const th = $('#theme'); const b = document.createElement('button'); b.id = 'refresh'; b.className = 'round'; b.setAttribute('aria-label', 'Refresh'); b.textContent = '↻'; b.style.marginLeft = 'auto'; th.style.marginLeft = '0'; th.before(b); b.onclick = refresh;
    let y0 = null; addEventListener('touchstart', e => { y0 = scrollY <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    addEventListener('touchend', e => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 90) refresh(); y0 = null; }, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  })();

  let started = false;
  async function start() {
    if (started) return; started = true;
    $('#tabs').hidden = false;
    try { const t = localStorage.getItem('tab'); if (t) tab = t; } catch (e) {}
    selectTab(tab);
    $('#tabs').onclick = e => { const b = e.target.closest('button[data-tab]'); if (b) selectTab(b.dataset.tab); };
    await load();
    sb.channel('live').on('postgres_changes', { event: '*', schema: 'public' }, () => { clearTimeout(load.t); load.t = setTimeout(load, 300); })
      .subscribe(s => { $('#live').hidden = s !== 'SUBSCRIBED'; });
  }
  function selectTab(t) {
    tab = t; try { localStorage.setItem('tab', t); } catch (e) {}
    document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
    render();
  }
  async function load() {
    const [i, v, c, t, pf, rs, stt, mt, hs] = await Promise.all([
      sb.from('ideas').select('*').order('rank', { ascending: false }).order('created_at', { ascending: false }),
      sb.from('versions').select('*').order('id'),
      sb.from('clips').select('*'),
      sb.from('taste').select('*'),
      sb.from('perf').select('*'),
      sb.from('results').select('*'),
      sb.from('status').select('*'),
      sb.from('metrics').select('*').order('posted_at'),
      sb.from('metrics_history').select('ig_media_id,captured_at,views,reach,saves,shares,likes').order('captured_at'),
    ]);
    if (i.error) { view.innerHTML = `<section class="card"><h2>No access</h2><p class="sub">${esc(i.error.message)}. Log in with the owner email.</p><button class="btn" id="out">Log out</button></section>`; $('#out').onclick = () => sb.auth.signOut().then(() => location.reload()); return; }
    data = { ideas: i.data || [], versions: v.data || [], clips: c.data || [], taste: t.data || [], perf: pf.data || [], results: rs.data || [], status: stt.data || [], metrics: mt.data || [], history: hs.data || [] };
    const n = s => data.ideas.filter(x => s.includes(x.status)).length;
    const counts = { ideas: n(['new']), film: n(['picked', 'filming']), post: n(['editing', 'ready']) };
    document.querySelectorAll('#tabs button').forEach(b => { const k = counts[b.dataset.tab]; b.innerHTML = (b.dataset.tab === 'taste' ? 'Insights' : b.dataset.tab[0].toUpperCase() + b.dataset.tab.slice(1)) + (k ? `<span class="n">${k}</span>` : ''); });
    render();
  }

  async function decide(idea, kind, choice, extra = {}) {
    await sb.from('decisions').insert({ idea_id: idea.id, kind, choice, reasons: extra.reasons || [], note: extra.note || null });
  }
  async function patchIdea(id, row) { const { error } = await sb.from('ideas').update(row).eq('id', id); if (error) toast(error.message); }

  // ---------- render ----------
  async function render() {
    if (!sb || busy) return;
    const by = s => data.ideas.filter(x => s.includes(x.status));
    let html = '';
    if (tab === 'ideas') {
      const list = by(['new']);
      html = list.length ? list.map(ideaCard).join('') : `<section class="card"><h2>No new ideas</h2><p class="sub">New ideas arrive every Sunday, copied from Reels that outperformed in your format. Your picks steer the next batch.</p></section>`;
    } else if (tab === 'film') {
      const list = by(['picked', 'filming']);
      html = list.length ? list.map(filmCard).join('') : `<section class="card"><h2>Nothing to film</h2><p class="sub">Pick ideas first. Picked ideas show up here with their shot list and an upload button per shot.</p></section>`;
    } else if (tab === 'post') {
      const list = by(['editing', 'ready', 'posted']).sort((a, b) => (a.status === 'posted') - (b.status === 'posted'));
      html = list.length ? (await Promise.all(list.map(postCard))).join('') : `<section class="card"><h2>Nothing to post yet</h2><p class="sub">After you upload the clips for an idea, the edited versions appear here within the hour.</p></section>`;
    } else html = tasteCard();
    view.innerHTML = html;
    hydrate();
  }

  const scriptHtml = i => `<div class="script">${(i.script || []).map(b => `<div class="beat"><span class="t">${esc(b.t)}</span><span>${esc(b.shot)}${b.onscreen ? `<span class="on">${esc(b.onscreen)}</span>` : ''}${b.note ? `<span class="sub" style="display:block">${esc(b.note)}</span>` : ''}</span></div>`).join('')}</div>`;
  const refHtml = i => `<div class="ref"><span class="chip score">${esc(i.ref_score)}x</span><span>${esc((+i.ref_views || 0).toLocaleString('en'))} views</span><span>·</span><a href="${esc(i.ref_url)}" target="_blank" rel="noopener">@${esc(i.ref_creator)} original ↗</a></div>`;

  function ideaCard(i) {
    const anims = (i.animations || []).map((a, ai) => `<div><h3>${esc(a.label)}</h3>${a.at ? `<p class="sub">${esc(a.at)}</p>` : ''}
      <div class="opts">${(a.options || []).map(o => `<button class="opt" data-act="anim" data-id="${esc(i.id)}" data-a="${ai}" data-o="${esc(o.id)}" aria-pressed="${a.picked === o.id}">
        ${o.preview ? `<video data-src="${esc(o.preview)}" muted loop playsinline autoplay></video>` : '<div class="ph"></div>'}<b>${esc(o.label)}</b><span>${esc(o.desc || '')}</span></button>`).join('')}</div></div>`).join('');
    const needAnim = (i.animations || []).some(a => !a.picked);
    const texts = (i.text_versions || []).map((t, ti) => `<label class="row" style="font-size:13.5px"><input type="checkbox" data-act="text" data-id="${esc(i.id)}" data-t="${ti}" ${t.off ? '' : 'checked'}> <span><b>${esc(t.id)}</b> ${esc(t.text || (t.beats || []).map(b => b.text).join(' → '))} <span class="sub">· ${esc(t.source || '')}</span></span></label>`).join('');
    const sounds = (i.sounds || []).map((s, si) => `<label class="row" style="font-size:13.5px"><input type="checkbox" data-act="sound" data-id="${esc(i.id)}" data-s="${si}" ${s.off ? '' : 'checked'}> <span>${esc(s.name)} <span class="sub">· ${esc(s.source || '')}</span></span></label>`).join('');
    const skip = skipping === i.id ? `<div class="reasons" data-for="${esc(i.id)}">${['Hook', 'Format', 'Topic', 'Animation', 'Sound', 'Not my style'].map(r => `<button data-r="${r}" aria-pressed="false">${r}</button>`).join('')}</div>
      <div class="row"><button class="btn" data-act="skipgo" data-id="${esc(i.id)}">Skip it</button><button class="btn small" data-act="skipcancel">Cancel</button></div>` : '';
    return `<section class="card">${refHtml(i)}
      <p class="hook">${esc(i.hook_text || i.title)}</p>
      <p class="sub">${esc(i.why || '')}</p>
      <div class="chips">${[i.format, i.hook_type, i.topic].filter(Boolean).map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>
      <details><summary>Full script</summary>${scriptHtml(i)}</details>
      ${anims ? `<div style="display:grid;gap:12px">${anims}</div>` : ''}
      ${(i.edit?.assets || []).length ? `<details><summary>Graphics used (made for you)</summary><div class="assets" style="display:grid;gap:8px;margin-top:8px">${i.edit.assets.map(x => `<div class="row" style="font-size:13.5px"><img data-asset="${esc(x.key || '')}" alt="" style="width:44px;height:44px;object-fit:contain;background:#222;border-radius:10px"><span><b>${esc(x.label)}</b><br><span class="sub">${esc(x.note || '')}</span></span></div>`).join('')}</div></details>` : ''}
      ${texts ? `<details><summary>Text versions to test</summary><div style="display:grid;gap:6px;margin-top:8px">${texts}</div></details>` : ''}
      ${sounds ? `<details><summary>Sounds to test</summary><div style="display:grid;gap:6px;margin-top:8px">${sounds}</div></details>` : ''}
      ${skip || `<div class="row"><button class="btn primary" data-act="pick" data-id="${esc(i.id)}" ${needAnim ? 'disabled' : ''}>Pick</button><button class="btn" data-act="skip" data-id="${esc(i.id)}">Skip</button>${needAnim ? '<span class="sub">Choose an animation first</span>' : ''}</div>`}
    </section>`;
  }

  function filmCard(i) {
    const slots = i.edit?.slots || [];
    const has = sl => data.clips.some(c => c.idea_id === i.id && c.slot === sl.id);
    const done = slots.length && slots.every(has);
    return `<section class="card">${refHtml(i)}<h2>${esc(i.title)}</h2>
      <ol class="list">${(i.film || []).map(f => `<li>${esc(f)}</li>`).join('')}</ol>
      <details><summary>Full script</summary>${scriptHtml(i)}</details>
      ${slots.map(sl => `<div class="slot"><span><b>${esc(sl.label || sl.id)}</b><br><span class="sub">${esc(sl.seconds ? sl.seconds + ' s' : '')}</span></span>
        ${has(sl) ? `<span class="done">Uploaded ✓</span>` : ''}
        <label class="btn ${has(sl) ? 'small' : 'primary'}">${has(sl) ? 'Replace' : 'Upload clip'}<input type="file" accept="video/*" hidden data-act="upload" data-id="${esc(i.id)}" data-slot="${esc(sl.id)}"></label></div>`).join('')}
      <p class="sub">${done ? 'All clips in. Editing starts within the hour.' : 'Film in 1080p, 30 fps (Settings › Camera › Record Video) so uploads stay fast.'}</p>
    </section>`;
  }

  // Save to phone: iOS/Android share sheet ("Save Video" → Photos); desktop falls back to a normal download.
  async function fileFor(path, name) { const blob = await (await fetch(await url(path))).blob(); return new File([blob], name, { type: 'video/mp4' }); }
  async function shareOrDownload(files) {
    if (navigator.canShare && navigator.canShare({ files })) { try { await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); await new Promise(r => setTimeout(r, 400)); }
    toast(files.length > 1 ? 'Downloaded ' + files.length + ' videos' : 'Downloaded');
  }
  async function saveVideo(path, name) { toast('Preparing video…'); await shareOrDownload([await fileFor(path, name)]); }
  const fmt = n => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
  const resultLine = v => { const r = data.results.find(x => x.version_id === v.id); return r ? `<span class="sub"><b>${fmt(r.views)}</b> views · ${r.lift}x your median · ${fmt(r.saves)} saves · ${fmt(r.shares)} shares</span>` : (v.posted ? '<span class="sub">Waiting for Instagram numbers…</span>' : ''); };
  async function postCard(i) {
    const vs = data.versions.filter(v => v.idea_id === i.id);
    const items = await Promise.all(vs.map(async v => `<div class="v">
      ${v.video_path ? `<video src="${esc(await url(v.video_path))}" poster="${esc(await url(v.cover_path))}" controls playsinline preload="none"></video>` : ''}
      <b>${esc(v.id.split('_').pop())}</b><span>${esc(v.text)}</span>${resultLine(v)}<span class="snd">♪ ${esc(v.sound)}</span>
      <div class="row"><button class="btn small" data-act="csound" data-v="${esc(v.id)}">Copy sound</button>
      ${v.video_path ? `<button class="btn small primary" data-act="dl" data-path="${esc(v.video_path)}" data-name="${esc(v.id)}.mp4">Save video</button>` : ''}
      <button class="btn small ${v.posted ? 'ok' : ''}" data-act="posted" data-v="${esc(v.id)}">${v.posted ? 'Posted ✓' : 'Posted'}</button></div></div>`));
    return `<section class="card">${refHtml(i)}<h2>${esc(i.title)}</h2>
      ${i.status === 'editing' ? '<p class="sub">Editing your clips now. Versions appear here when they are done.</p>' : `<div class="versions">${items.join('')}</div>`}
      <div class="cap">${esc(i.caption || '')}</div>
      <div class="row">${vs.some(v => v.video_path) ? `<button class="btn primary" data-act="dlall" data-id="${esc(i.id)}">Save all ${vs.filter(v => v.video_path).length} videos</button>` : ''}<button class="btn" data-act="ccap" data-id="${esc(i.id)}">Copy caption</button>${i.keyword && i.keyword !== '-' ? `<span class="sub">DM keyword <b>${esc(i.keyword)}</b></span>` : ''}</div>
      <p class="sub">Post each version as its own Trial Reel and add its sound in Instagram.</p></section>`;
  }

  // ---------- insights: charts are inline SVG, one series each (single accent hue), tap a bar to open that Reel ----------
  const nfmt = n => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
  const pct = (a, b) => b ? (100 * a / b) : null;
  const pf1 = x => x == null ? '–' : x.toFixed(x < 10 ? 1 : 0) + '%';
  const dshort = t => { const d = new Date(t); return d.getDate() + '/' + (d.getMonth() + 1); };
  const med = a => { const x = a.filter(v => v != null).sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : null; };
  function barChart(items, { unit = '', median = null, sel = null, color = 'var(--accent)', label = 'chart' } = {}) {
    const W = 340, H = 140, L = 4, R = 4, T = 14, B = 22, n = items.length, max = Math.max(1, ...items.map(i => i.v || 0), median || 0) * 1.12;
    const step = (W - L - R) / Math.max(n, 1), bw = Math.max(4, Math.min(22, step - 5)), y = v => T + (H - T - B) * (1 - (v || 0) / max);
    const bars = items.map((it, k) => { const x = L + step * k + (step - bw) / 2, yy = y(it.v), h = Math.max(1, H - B - yy), on = it.id === sel;
      return `<g data-act="reel" data-mid="${esc(it.id)}" style="cursor:pointer"><title>${esc(it.tip)}</title><rect x="${L + step * k}" y="0" width="${step}" height="${H}" fill="transparent"/>
        <path d="M${x} ${H - B} V${yy + 3} Q${x} ${yy} ${x + 3} ${yy} H${x + bw - 3} Q${x + bw} ${yy} ${x + bw} ${yy + 3} V${H - B} Z" style="fill:${color};opacity:${on || sel == null ? 1 : .35}"/>
        ${on || it.v === max / 1.12 ? `<text x="${x + bw / 2}" y="${yy - 4}" text-anchor="middle" font-size="10" font-weight="700" style="fill:var(--ink)">${esc(nfmt(it.v) + unit)}</text>` : ''}
        ${k % Math.ceil(n / 8) === 0 ? `<text x="${x + bw / 2}" y="${H - 7}" text-anchor="middle" font-size="9" style="fill:var(--muted)">${esc(it.x)}</text>` : ''}</g>`; }).join('');
    const ml = median ? `<line x1="${L}" x2="${W - R}" y1="${y(median)}" y2="${y(median)}" stroke-dasharray="3 3" style="stroke:var(--muted)" stroke-width="1"/><text x="${L + 2}" y="${y(median) - 3}" text-anchor="start" font-size="9" style="fill:var(--muted)">median ${esc(nfmt(median) + unit)}</text>` : '';
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(label)}"><line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" style="stroke:var(--line)"/>${ml}${bars}</svg>`;
  }
  function lineChart(pts, { label = 'growth' } = {}) {
    if (pts.length < 2) return '<p class="sub">The growth curve fills in as the numbers change over the next hours and days.</p>';
    const W = 340, H = 110, L = 30, R = 8, T = 10, B = 20, t0 = +new Date(pts[0].t), t1 = +new Date(pts[pts.length - 1].t) || t0 + 1, max = Math.max(1, ...pts.map(p => p.v)) * 1.1;
    const X = t => L + (W - L - R) * ((+new Date(t) - t0) / Math.max(1, t1 - t0)), Y = v => T + (H - T - B) * (1 - v / max);
    const d = pts.map((p, k) => (k ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' '), last = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(label)}"><line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" style="stroke:var(--line)"/><line x1="${L}" x2="${W - R}" y1="${Y(max / 1.1)}" y2="${Y(max / 1.1)}" style="stroke:var(--line)" stroke-dasharray="2 4"/>
      <text x="${L - 4}" y="${Y(max / 1.1) + 3}" text-anchor="end" font-size="9" style="fill:var(--muted)">${esc(nfmt(max / 1.1))}</text><text x="${L}" y="${H - 6}" font-size="9" style="fill:var(--muted)">${esc(dshort(pts[0].t))}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="9" style="fill:var(--muted)">${esc(dshort(last.t))}</text>
      <path d="${d}" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--accent)"/><circle cx="${X(last.t)}" cy="${Y(last.v)}" r="4" style="fill:var(--accent);stroke:var(--glass);stroke-width:2"/></svg>`;
  }
  function insightsHtml() {
    const R = data.results, st = (data.status.find(x => x.key === 'instagram') || {}).value || null, ago = t => { const m = Math.round((Date.now() - new Date(t)) / 6e4); return m < 2 ? 'just now' : m < 90 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
    const conn = !st ? `<span class="chip">Instagram: not synced yet</span>` : st.ok ? `<span class="chip" style="background:var(--ok);color:#fff">Instagram connected · synced ${esc(ago(st.at))}</span>` : `<span class="chip" style="background:var(--bad);color:#fff">Instagram not connected</span><p class="sub">${esc(String(st.error || '').slice(0, 140))}</p>`;
    const M = data.metrics.filter(m => m.views != null).sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));
    const linked = Object.fromEntries(R.map(r => [r.ig_media_id, r]));
    const rate = m => ({ save: pct((m.saves || 0) + (m.shares || 0), m.reach), eng: pct((m.likes || 0) + (m.comments || 0) + (m.saves || 0) + (m.shares || 0), m.reach), watch: m.watch_ms ? m.watch_ms / 1000 : null });
    if (!M.length) return `<section class="card"><h2>Insights</h2>${conn}<p class="empty">No Reels read yet. They appear here within the hour once Instagram is connected.</p></section>`;
    const medV = med(M.map(m => m.views)), totV = M.reduce((s, m) => s + (+m.views || 0), 0), best = [...M].sort((a, b) => b.views - a.views)[0];
    const avgSave = M.reduce((s, m) => s + (rate(m).save || 0), 0) / M.length, avgW = M.filter(m => m.watch_ms).reduce((s, m) => s + m.watch_ms / 1000, 0) / Math.max(1, M.filter(m => m.watch_ms).length);
    const last3 = M.slice(-3), prev3 = M.slice(-6, -3), tr = prev3.length ? (med(last3.map(m => m.views)) / Math.max(1, med(prev3.map(m => m.views))) - 1) * 100 : null;
    if (!selReel || !M.some(m => m.ig_media_id === selReel)) selReel = M[M.length - 1].ig_media_id;
    const tile = (n, l, sub = '') => `<div style="background:var(--glass-2);border-radius:16px;padding:12px;min-width:0"><div style="font-size:22px;font-weight:700;letter-spacing:-.01em">${n}</div><div class="sub">${l}</div>${sub}</div>`;
    const tiles = `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">${tile(M.length, 'Reels tracked')}${tile(nfmt(totV), 'total views')}${tile(nfmt(medV), 'median views per Reel', tr == null ? '' : `<div class="sub" style="color:${tr >= 0 ? 'var(--ok)' : 'var(--bad)'}">${tr >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(tr))}% vs previous 3</div>`)}${tile(nfmt(best.views), 'best Reel', `<div class="sub">${esc(dshort(best.posted_at))} · ${esc((best.caption || '').slice(0, 24))}</div>`)}${tile(pf1(avgSave), 'saves + shares per reach')}${tile(avgW ? avgW.toFixed(1) + 's' : '–', 'avg watch time')}</div>`;
    const tipOf = m => `${dshort(m.posted_at)} · ${nfmt(m.views)} views · ${pf1(rate(m).save)} saves+shares · ${rate(m).watch ? rate(m).watch.toFixed(1) + 's watched' : ''}`;
    const items = f => M.map(m => ({ id: m.ig_media_id, v: f(m), x: dshort(m.posted_at), tip: tipOf(m) }));
    const charts = `<section class="card"><h2>Views per Reel</h2><p class="sub">Oldest to newest. Tap a bar to open that Reel.</p>${barChart(items(m => +m.views), { median: medV, sel: selReel, label: 'Views per Reel' })}</section>
      <section class="card"><h2>Saves + shares per reach</h2><p class="sub">The signal Instagram rewards most. Higher means people want to keep or send it.</p>${barChart(items(m => rate(m).save), { unit: '%', median: med(M.map(m => rate(m).save)), sel: selReel, color: 'var(--ok)', label: 'Saves and shares per reach' })}</section>
      <section class="card"><h2>Average watch time</h2><p class="sub">Seconds. Compare against the length of the Reel.</p>${barChart(items(m => rate(m).watch), { unit: 's', median: med(M.map(m => rate(m).watch)), sel: selReel, color: 'var(--muted)', label: 'Average watch time' })}</section>`;
    // detail of the selected Reel
    const m = M.find(x => x.ig_media_id === selReel), r = rate(m), L = linked[m.ig_media_id];
    const hist = data.history.filter(h => h.ig_media_id === m.ig_media_id).map(h => ({ t: h.captured_at, v: +h.views }));
    const vs = (v, base, f = x => x) => base ? `<span class="sub" style="color:${v >= base ? 'var(--ok)' : 'var(--muted)'}">${v >= base ? '▲' : '▼'} ${(v / base).toFixed(1)}x avg</span>` : '';
    const stat = (n, l, extra = '') => `<div style="background:var(--glass-2);border-radius:14px;padding:10px;min-width:0"><div style="font-size:18px;font-weight:700">${n}</div><div class="sub">${l}</div>${extra}</div>`;
    const detail = `<section class="card" id="reel-detail"><h2>${esc((m.caption || 'Reel').split('\n')[0].slice(0, 70))}</h2><p class="sub">Posted ${esc(new Date(m.posted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))} · ${esc(m.media_type || 'REELS')} · <a href="${esc(m.permalink || '#')}" target="_blank" rel="noopener">open on Instagram ↗</a></p>
      ${L ? `<div class="chips"><span class="chip score">${esc(L.lift)}x your median</span><span class="chip">${esc(L.format || '')}</span><span class="chip">${esc(L.hook_type || '')}</span><span class="chip">♪ ${esc((L.sound || '').slice(0, 30))}</span></div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">${stat(nfmt(m.views), 'views', vs(+m.views, medV))}${stat(nfmt(m.reach), 'reach')}${stat(r.watch ? r.watch.toFixed(1) + 's' : '–', 'avg watch', vs(r.watch, avgW))}${stat(nfmt(m.saves), 'saves')}${stat(nfmt(m.shares), 'shares')}${stat(nfmt(m.likes) + ' / ' + nfmt(m.comments), 'likes / comments')}</div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">${stat(pf1(r.save), 'saves+shares per reach', vs(r.save, avgSave))}${stat(pf1(r.eng), 'engagement per reach')}</div>
      <h3>Views over time</h3>${lineChart(hist, { label: 'Views over time for this Reel' })}</section>`;
    // ranking table of every Reel
    const rank = [...M].sort((a, b) => b.views - a.views).map(x => { const rr = rate(x); return `<div class="trow" data-act="reel" data-mid="${esc(x.ig_media_id)}" style="grid-template-columns:1fr 54px 54px;cursor:pointer;${x.ig_media_id === selReel ? 'font-weight:700' : ''}"><span>${esc((x.caption || '').split('\n')[0].slice(0, 36) || 'Reel')}<br><span class="sub">${esc(dshort(x.posted_at))}${linked[x.ig_media_id] ? ' · ' + esc(linked[x.ig_media_id].version_id.split('_').pop()) : ''}</span></span><span class="sub">${pf1(rr.save)}</span><span>${nfmt(x.views)}</span></div>`; }).join('');
    const board = `<section class="card"><h2>All Reels</h2><p class="sub">Views, with saves+shares per reach. Tap a row to open it.</p>${rank}</section>`;
    const byIdea = {}; R.forEach(x => (byIdea[x.idea_id] ||= []).push(x));
    const ab = Object.values(byIdea).filter(g => g.length > 1).map(g => { const top = Math.max(...g.map(x => +x.views || 0)); return `<div class="taste"><h3>${esc(g[0].title)}</h3>${g.sort((a, b) => b.views - a.views).map(x => `<div class="trow" style="grid-template-columns:1fr 54px 60px"><span>${esc(x.version_id.split('_').pop())} · ${esc((x.text || '').slice(0, 40))}<br><span class="sub">♪ ${esc((x.sound || '').slice(0, 40))}</span></span><span class="sub">${x.lift}x</span><span>${+x.views === top ? '🏆 ' : ''}${nfmt(x.views)}</span></div>`).join('')}</div>`; }).join('');
    const wd = { format: 'Formats', hook_type: 'Hook types', topic: 'Topics', text_style: 'Text styles', creator: 'Reference creators', sound: 'Sounds', text: 'Text versions' };
    const worked = Object.entries(wd).map(([k, label]) => { const rows = data.perf.filter(p => p.dim === k).sort((a, b) => b.score - a.score).slice(0, 5); if (!rows.length) return ''; return `<div class="taste"><h3>${label}</h3>${rows.map(x => `<div class="trow"><span>${esc(x.val)}</span><span class="meter"><i style="width:${Math.min(100, Math.round(x.score * 10))}%"></i></span><span class="sub">${x.avg_lift}x · ${x.n}</span></div>`).join('')}</div>`; }).join('');
    const hint = R.length ? '' : `<p class="sub">All your posted Reels are already counted above. To see which idea, text and sound each one used, tap <b>Posted</b> on new versions in the Post tab: they link to their Reel automatically.</p>`;
    return `<section class="card"><h2>Insights</h2>${conn}${tiles}${hint}</section>${charts}${detail}${board}`
      + (ab ? `<section class="card"><h2>A/B tests</h2><p class="sub">Versions of the same idea. 🏆 = most views.</p>${ab}</section>` : '')
      + (worked ? `<section class="card"><h2>What works for you</h2><p class="sub">Per format, hook, sound and text: average multiple of your median, and how many posts. Next week's ideas lean on this.</p>${worked}</section>` : '');
  }
  function tasteCard() {
    const d = data.ideas;
    const picked = d.filter(x => !['new', 'skipped'].includes(x.status)).length, skipped = d.filter(x => x.status === 'skipped').length;
    const dims = { format: 'Formats', hook_type: 'Hook types', topic: 'Topics', text_style: 'Text styles', creator: 'Reference creators', animation: 'Animation picks' };
    const groups = Object.entries(dims).map(([k, label]) => {
      const rows = data.taste.filter(t => t.dim === k).sort((a, b) => b.score - a.score || b.picks - a.picks);
      if (!rows.length) return '';
      return `<div class="taste"><h3>${label}</h3>${rows.map(r => `<div class="trow"><span>${esc(r.val)}</span><span class="meter"><i style="width:${Math.round(r.score * 100)}%"></i></span><span class="sub">${r.picks}/${r.picks + r.skips}</span></div>`).join('')}</div>`;
    }).join('');
    return insightsHtml() + `<section class="card"><h2>Your taste</h2><p class="sub">${picked} picked · ${skipped} skipped. Next week's ideas lean toward what scores high here.</p>${groups || '<p class="empty">Pick or skip a few ideas and this fills in.</p>'}</section>`;
  }

  async function hydrate() {
    for (const v of view.querySelectorAll('video[data-src]')) v.src = await url(v.dataset.src);
    for (const im of view.querySelectorAll('img[data-asset]')) if (im.dataset.asset) im.src = await url(im.dataset.asset);
  }

  // ---------- actions ----------
  view.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'INPUT') return;
    const act = b.dataset.act, idea = data.ideas.find(x => x.id === b.dataset.id);
    if (b.closest('.reasons') && b.dataset.r) { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); return; }
    if (act === 'anim') {
      const anims = structuredClone(idea.animations); anims[+b.dataset.a].picked = b.dataset.o;
      idea.animations = anims; render();
      await patchIdea(idea.id, { animations: anims });
      await decide(idea, 'animation', b.dataset.o, { note: anims[+b.dataset.a].key });
    }
    if (act === 'pick') { idea.status = 'picked'; render(); await patchIdea(idea.id, { status: 'picked' }); await decide(idea, 'idea', 'pick'); toast('Picked. It is in Film now'); }
    if (act === 'skip') { skipping = idea.id; render(); }
    if (act === 'skipcancel') { skipping = null; render(); }
    if (act === 'skipgo') {
      const reasons = [...view.querySelectorAll(`.reasons[data-for="${CSS.escape(idea.id)}"] button[aria-pressed="true"]`)].map(x => x.dataset.r);
      skipping = null; idea.status = 'skipped'; render();
      await patchIdea(idea.id, { status: 'skipped' }); await decide(idea, 'idea', 'skip', { reasons });
    }
    if (act === 'reel') { selReel = b.dataset.mid; render(); document.getElementById('reel-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (act === 'dl') { b.disabled = true; try { await saveVideo(b.dataset.path, b.dataset.name); } finally { b.disabled = false; } return; }
    if (act === 'dlall') { b.disabled = true; try { const vs = data.versions.filter(v => v.idea_id === b.dataset.id && v.video_path); const files = await Promise.all(vs.map(v => fileFor(v.video_path, v.id + '.mp4'))); await shareOrDownload(files); } finally { b.disabled = false; } return; }
    if (act === 'ccap') copy(idea.caption || '', 'Caption');
    if (act === 'csound') copy(data.versions.find(v => v.id === b.dataset.v)?.sound || '', 'Sound');
    if (act === 'posted') {
      const v = data.versions.find(x => x.id === b.dataset.v); v.posted = !v.posted; render();
      await sb.from('versions').update({ posted: v.posted, posted_at: v.posted ? new Date().toISOString() : null }).eq('id', v.id);
      const all = data.versions.filter(x => x.idea_id === v.idea_id);
      if (all.every(x => x.posted)) await patchIdea(v.idea_id, { status: 'posted' });
    }
  });
  view.addEventListener('change', async e => {
    const el = e.target, idea = data.ideas.find(x => x.id === el.dataset.id); if (!idea) return;
    if (el.dataset.act === 'text' || el.dataset.act === 'sound') {
      const key = el.dataset.act === 'text' ? 'text_versions' : 'sounds', idx = +(el.dataset.t ?? el.dataset.s);
      const arr = structuredClone(idea[key]); arr[idx].off = !el.checked; idea[key] = arr;
      await patchIdea(idea.id, { [key]: arr });
      await decide(idea, el.dataset.act, el.checked ? 'on' : 'off', { note: arr[idx].id || arr[idx].name });
    }
    if (el.dataset.act === 'upload' && el.files[0]) {
      const f = el.files[0], ext = (f.name.split('.').pop() || 'mov').toLowerCase();
      const path = `clips/${idea.id}/${el.dataset.slot}-${Date.now()}.${ext}`;
      busy = true; toast(`Uploading ${(f.size / 1e6).toFixed(0)} MB…`);
      const { error } = await sb.storage.from('reels').upload(path, f, { contentType: f.type || 'video/quicktime', upsert: true });
      busy = false;
      if (error) { toast(error.message.includes('size') ? 'Clip too big. Film in 1080p 30fps' : error.message); return; }
      await sb.from('clips').insert({ idea_id: idea.id, slot: el.dataset.slot, path });
      if (idea.status === 'picked') await patchIdea(idea.id, { status: 'filming' });
      toast('Uploaded'); load();
    }
  });
})();
