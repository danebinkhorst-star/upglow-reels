/* Reels — phone app. Data lives in Supabase (live via realtime); everything here is owner-only via RLS. */
(() => {
  const C = window.REELS_CONFIG || {};
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const view = $('#view');
  let sb, tab = 'ideas', data = { ideas: [], versions: [], clips: [], taste: [] }, signed = {}, skipping = null, busy = false;

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
    const [i, v, c, t] = await Promise.all([
      sb.from('ideas').select('*').order('rank', { ascending: false }).order('created_at', { ascending: false }),
      sb.from('versions').select('*').order('id'),
      sb.from('clips').select('*'),
      sb.from('taste').select('*'),
    ]);
    if (i.error) { view.innerHTML = `<section class="card"><h2>No access</h2><p class="sub">${esc(i.error.message)}. Log in with the owner email.</p><button class="btn" id="out">Log out</button></section>`; $('#out').onclick = () => sb.auth.signOut().then(() => location.reload()); return; }
    data = { ideas: i.data || [], versions: v.data || [], clips: c.data || [], taste: t.data || [] };
    const n = s => data.ideas.filter(x => s.includes(x.status)).length;
    const counts = { ideas: n(['new']), film: n(['picked', 'filming']), post: n(['editing', 'ready']) };
    document.querySelectorAll('#tabs button').forEach(b => { const k = counts[b.dataset.tab]; b.innerHTML = b.dataset.tab[0].toUpperCase() + b.dataset.tab.slice(1) + (k ? `<span class="n">${k}</span>` : ''); });
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

  async function postCard(i) {
    const vs = data.versions.filter(v => v.idea_id === i.id);
    const items = await Promise.all(vs.map(async v => `<div class="v">
      ${v.video_path ? `<video src="${esc(await url(v.video_path))}" poster="${esc(await url(v.cover_path))}" controls playsinline preload="none"></video>` : ''}
      <b>${esc(v.id.split('_').pop())}</b><span>${esc(v.text)}</span><span class="snd">♪ ${esc(v.sound)}</span>
      <div class="row"><button class="btn small" data-act="csound" data-v="${esc(v.id)}">Copy sound</button>
      ${v.video_path ? `<a class="btn small" href="${esc(await url(v.video_path))}" target="_blank" rel="noopener">Save</a>` : ''}
      <button class="btn small ${v.posted ? 'ok' : ''}" data-act="posted" data-v="${esc(v.id)}">${v.posted ? 'Posted ✓' : 'Posted'}</button></div></div>`));
    return `<section class="card">${refHtml(i)}<h2>${esc(i.title)}</h2>
      ${i.status === 'editing' ? '<p class="sub">Editing your clips now. Versions appear here when they are done.</p>' : `<div class="versions">${items.join('')}</div>`}
      <div class="cap">${esc(i.caption || '')}</div>
      <div class="row"><button class="btn primary" data-act="ccap" data-id="${esc(i.id)}">Copy caption</button>${i.keyword && i.keyword !== '-' ? `<span class="sub">DM keyword <b>${esc(i.keyword)}</b></span>` : ''}</div>
      <p class="sub">Post each version as its own Trial Reel and add its sound in Instagram.</p></section>`;
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
    return `<section class="card"><h2>Your taste</h2><p class="sub">${picked} picked · ${skipped} skipped. Next week's ideas lean toward what scores high here.</p>${groups || '<p class="empty">Pick or skip a few ideas and this fills in.</p>'}</section>`;
  }

  async function hydrate() {
    for (const v of view.querySelectorAll('video[data-src]')) v.src = await url(v.dataset.src);
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
