/* Reels — Make tab. Upload any video(s), no idea needed. Auto decides narrator / captions / hook text / sound from the footage,
   or you tick it yourself. The render engine (engine/tools/quick.mjs) does the analysis + edit; copy is written by Claude
   (or the quick-draft fallback). Jobs are `ideas` rows with format 'quick' and status 'quick' until they are rendered. */
window.ReelsMake = (() => {
  let X = {}, bound = false;
  const F = () => window.ReelsFilm;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const MAXN = 6;
  const PRESETS = {
    auto: { label: 'Auto', hook: 'auto', captions: 'auto', narr: 'auto', orig: 'auto', music: 'auto' },
    cm: { label: 'Captions + music only', hook: 'off', captions: 'on', narr: 'off', orig: 'auto', music: 'on' },
    hm: { label: 'Hook text + music', hook: 'on', captions: 'off', narr: 'off', orig: 'auto', music: 'on' },
    clean: { label: 'Clean (just trimmed)', hook: 'off', captions: 'off', narr: 'off', orig: 'on', music: 'off' },
    all: { label: 'Everything', hook: 'on', captions: 'on', narr: 'on', orig: 'auto', music: 'auto' },
  };
  const ROWS = [['hook', 'Hook text on screen'], ['captions', 'Captions'], ['narr', 'Narrator (my voice)'], ['orig', 'Original sound'], ['music', 'Music / sound']];
  const S = { preset: 'auto', ...PRESETS.auto, length: 'auto', context: '', narrText: '', files: [], busy: false, prog: null };
  const STATE = { uploading: 'Uploading…', queued: 'Waiting for your computer to pick it up', analysing: 'Analysing the footage', needs_copy: 'Waiting for the hook / narration copy', rendering: 'Rendering', done: 'Done. Open the Post tab', error: 'Something went wrong' };

  function init(ctx) {
    X = ctx;
    if (bound) return; bound = true;
    const view = document.querySelector('#view');
    view.addEventListener('click', onClick);
    view.addEventListener('input', e => {
      if (e.target.id === 'mk-ctx') S.context = e.target.value;
      if (e.target.id === 'mk-nt') S.narrText = e.target.value;
    });
    view.addEventListener('change', e => {
      if (e.target.id !== 'mk-files') return;
      const add = [...e.target.files].filter(f => /^video\//.test(f.type) || /\.(mov|mp4|m4v|webm)$/i.test(f.name));
      S.files = [...S.files, ...add].slice(0, MAXN); e.target.value = ''; paint();
    });
  }

  const seg = (k, v) => `<div class="seg" role="group">${['auto', 'on', 'off'].map(x => `<button data-mk="set" data-k="${k}" data-v="${x}" aria-pressed="${v === x}">${x === 'auto' ? 'Auto' : x === 'on' ? 'On' : 'Off'}</button>`).join('')}</div>`;
  function formHtml() {
    const fl = S.files.map((f, i) => `<div class="mk-file"><span>${esc(f.name)} <span class="sub">${F().MB(f.size)}</span></span><button class="btn small" data-mk="rm" data-i="${i}" ${S.busy ? 'disabled' : ''}>Remove</button></div>`).join('');
    const vc = (X.data().status || []).find(s => s.key === 'voice')?.value;
    return `<section class="card" id="mk-form"><h2>Make a Reel from any video</h2>
      <p class="sub">No idea needed. Drop in one or more clips. Auto looks at what is in the footage and decides what it needs.</p>
      <label class="btn primary mk-pick">${S.files.length ? 'Add more videos' : 'Choose videos'}<input type="file" id="mk-files" accept="video/*" multiple hidden></label>
      ${fl}
      <div class="chips">${Object.entries(PRESETS).map(([k, p]) => `<button class="chip" data-mk="preset" data-k="${k}" aria-pressed="${S.preset === k}">${p.label}</button>`).join('')}</div>
      ${ROWS.map(([k, l]) => `<div class="mk-row"><b>${l}</b>${seg(k, S[k])}</div>`).join('')}
      ${S.narr !== 'off' ? `<div><textarea id="mk-nt" class="mk-in" rows="3" placeholder="Narration text. Leave empty and Claude writes it.">${esc(S.narrText)}</textarea>${vc ? '' : '<p class="sub">No voice saved yet. Record it in the Film tab first or the narrator is skipped.</p>'}</div>` : ''}
      <div class="mk-row"><b>Length</b><div class="chips">${['auto', '15', '30', '60'].map(x => `<button class="chip" data-mk="len" data-v="${x}" aria-pressed="${S.length === x}">${x === 'auto' ? 'Auto' : x + ' s'}</button>`).join('')}</div></div>
      <input id="mk-ctx" class="mk-in" placeholder="What is this about? (optional, helps the hook)" value="${esc(S.context)}">
      <p class="sub">Auto: speech in the video means no narrator, captions on, original sound kept. Silent footage gets a hook and a sound to add in Instagram.</p>
      ${S.prog ? `<div class="bar-prog"><i style="width:${Math.round(S.prog.f * 100)}%"></i><span>${esc(S.prog.t)}</span></div>` : ''}
      <div class="row"><button class="btn primary" data-mk="go" ${S.files.length && !S.busy ? '' : 'disabled'}>Make my Reel${S.files.length > 1 ? ` from ${S.files.length} clips` : ''}</button></div></section>`;
  }
  function jobsHtml() {
    const jobs = (X.data().ideas || []).filter(i => i.format === 'quick' && i.status !== 'draft').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (!jobs.length) return '';
    return jobs.map(i => {
      const q = i.edit?.quick || {}, st = i.status === 'ready' || i.status === 'posted' ? 'done' : (q.state || 'queued');
      const dec = q.decisions ? `<p class="sub">Auto chose: ${esc(q.decisions)}</p>` : '';
      const act = st === 'needs_copy' && !q.fallback ? `<button class="btn small" data-mk="fallback" data-id="${esc(i.id)}">Use quick draft instead</button>`
        : st === 'error' ? `<button class="btn small" data-mk="retry" data-id="${esc(i.id)}">Retry</button>`
        : st === 'done' ? `<button class="btn small primary" data-mk="open">Open in Post</button>` : '';
      return `<section class="card"><div class="mk-row"><h3>${esc(i.title)}</h3><span class="chip">${esc(STATE[st] || st)}</span></div>${dec}${q.error ? `<p class="sub warn">${esc(q.error)}</p>` : ''}${st === 'needs_copy' ? `<p class="sub">${q.fallback ? 'Quick draft will be used.' : 'Ask Claude: "check my quick reels". Or use the quick draft.'}</p>` : ''}${act ? `<div class="row">${act}</div>` : ''}</section>`;
    }).join('');
  }
  function paint() { const f = document.querySelector('#mk-form'); if (f) f.outerHTML = formHtml(); }
  function render(view) {
    if (!view.querySelector('#mk-form')) { view.innerHTML = formHtml() + `<div id="mk-jobs" style="display:grid;gap:14px">${jobsHtml()}</div>`; return true; }
    const j = view.querySelector('#mk-jobs'); if (j) j.innerHTML = jobsHtml();
    return true;
  }

  async function patchQuick(id, patch, status) {
    const i = X.data().ideas.find(x => x.id === id); if (!i) return;
    const edit = { ...(i.edit || {}), quick: { ...(i.edit?.quick || {}), ...patch } };
    const row = { edit }; if (status) row.status = status;
    const { error } = await X.sb.from('ideas').update(row).eq('id', id);
    if (error) X.toast(error.message); else { i.edit = edit; if (status) i.status = status; }
  }
  const meta = file => new Promise(res => {
    const v = document.createElement('video'), u = URL.createObjectURL(file); v.preload = 'metadata'; v.muted = true; v.playsInline = true;
    const done = o => { URL.revokeObjectURL(u); res(o); };
    v.onloadedmetadata = () => done({ dur: F().r1(v.duration || 0), w: v.videoWidth, h: v.videoHeight, bytes: file.size });
    v.onerror = () => done({ bytes: file.size }); setTimeout(() => done({ bytes: file.size }), 8000); v.src = u;
  });

  async function go() {
    const files = S.files.slice(); if (!files.length || S.busy) return;
    const big = files.find(f => f.size > F().BUCKET_MAX); if (big) { X.toast(`${big.name} is over 500 MB. Trim it in Photos first.`); return; }
    S.busy = true; S.prog = { f: 0, t: 'Starting…' }; paint();
    const id = 'q-' + Date.now().toString(36), d = new Date();
    const title = `Quick Reel ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    const options = { hook: S.hook, captions: S.captions, narr: S.narr, orig: S.orig, music: S.music, narrText: S.narrText.trim() };
    const slots = files.map((f, i) => ({ id: 'c' + (i + 1), label: f.name, seconds: 0 }));
    const edit = { tier: 'quick', slots, quick: { options, length: S.length, context: S.context.trim(), state: 'uploading', fallback: false } };
    try {
      let r = await X.sb.from('ideas').insert({ id, status: 'draft', format: 'quick', title, edit });
      if (r.error) throw r.error;
      for (let i = 0; i < files.length; i++) {
        const f = files[i], tag = files.length > 1 ? `Clip ${i + 1}/${files.length}: ` : '';
        S.prog = { f: 0, t: tag + 'reading…' }; paint();
        const m = await meta(f), ext = (f.name.split('.').pop() || 'mov').toLowerCase(), path = `clips/${id}/c${i + 1}-${Date.now()}.${ext}`;
        await F().uploadWithProgress(path, f, p => { S.prog = { f: (i + p) / files.length, t: `${tag}uploading ${F().MB(f.size)}… ${Math.round(p * 100)}%` }; paint(); });
        const row = { idea_id: id, slot: 'c' + (i + 1), path, plan: { in: 0, out: m.dur || null, speed: 1, mute: false, name: f.name, source: m } };
        let c = await X.sb.from('clips').insert(row);
        if (c.error && /plan/.test(c.error.message)) c = await X.sb.from('clips').insert({ idea_id: id, slot: row.slot, path });
        if (c.error) throw c.error;
      }
      const e2 = { ...edit, quick: { ...edit.quick, state: 'queued' } };
      const u = await X.sb.from('ideas').update({ status: 'quick', edit: e2 }).eq('id', id); if (u.error) throw u.error;
      S.files = []; S.prog = null; S.busy = false; X.toast('Uploaded. Your computer picks it up within a minute'); await X.load();
    } catch (err) {
      S.busy = false; S.prog = null; paint(); X.toast(err.message || 'Upload failed');
      X.sb.from('ideas').delete().eq('id', id).then(() => {}, () => {});
    }
  }

  function onClick(e) {
    const b = e.target.closest('[data-mk]'); if (!b) return;
    const a = b.dataset.mk;
    if (a === 'set') { S[b.dataset.k] = b.dataset.v; S.preset = ''; paint(); }
    else if (a === 'preset') { Object.assign(S, PRESETS[b.dataset.k], { preset: b.dataset.k }); paint(); }
    else if (a === 'len') { S.length = b.dataset.v; paint(); }
    else if (a === 'rm') { S.files.splice(+b.dataset.i, 1); paint(); }
    else if (a === 'go') go();
    else if (a === 'fallback') { patchQuick(b.dataset.id, { fallback: true }).then(() => { X.toast('Quick draft will be used'); X.load(); }); }
    else if (a === 'retry') { patchQuick(b.dataset.id, { state: 'queued', error: null }).then(() => X.load()); }
    else if (a === 'open') { document.querySelector('#tabs [data-tab="post"]')?.click(); }
  }

  return { init, render };
})();
