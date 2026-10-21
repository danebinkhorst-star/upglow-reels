/* Reels — interactive clip upload + narrator voice.
   Picks a clip, previews it, measures it, suggests an edit (smart cut / speed up / keep), lets you adjust trim + speed,
   optionally shrinks it on the phone, uploads with a progress bar and saves the edit plan next to the clip.
   The render engine (engine/tools/sync.mjs + render.mjs) executes that plan.
   Also: record/upload your own voice sample once (used by the engine to clone your voice for narration). */
window.ReelsFilm = (() => {
  let X = {};
  const BUCKET_MAX = 500 * 1024 * 1024;           // storage bucket limit (see supabase/schema.sql)
  const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const r1 = n => Math.round(n * 10) / 10;
  const MB = b => (b / 1e6).toFixed(b > 1e8 ? 0 : 1) + ' MB';
  const once = (el, ev) => new Promise(res => el.addEventListener(ev, res, { once: true }));
  function init(ctx) { X = ctx; }
  const voice = () => (X.data().status || []).find(s => s.key === 'voice')?.value || null;

  // ---------- analysis ----------
  // Motion per sample = mean absolute difference between consecutive tiny grayscale frames. High = something happens.
  async function analyzeMotion(video, dur, onProg, cancelled) {
    const n = Math.min(90, Math.max(8, Math.round(dur / 0.4))), step = dur / n;
    const cv = document.createElement('canvas'); cv.width = 36; cv.height = 64;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const out = []; let prev = null;
    for (let i = 0; i < n; i++) {
      if (cancelled()) return null;
      video.currentTime = Math.min(dur - 0.05, i * step + step / 2);
      await once(video, 'seeked');
      cx.drawImage(video, 0, 0, 36, 64);
      const px = cx.getImageData(0, 0, 36, 64).data; let d = 0;
      const g = new Float32Array(36 * 64); for (let k = 0; k < g.length; k++) g[k] = (px[k * 4] + px[k * 4 + 1] + px[k * 4 + 2]) / 3;
      if (prev) { for (let k = 0; k < g.length; k++) d += Math.abs(g[k] - prev[k]); d /= g.length; }
      out.push({ t: i * step, m: d }); prev = g;
      onProg && onProg((i + 1) / n);
    }
    const sorted = out.map(o => o.m).sort((a, b) => a - b), p90 = Math.max(1e-3, sorted[Math.floor(sorted.length * 0.9)] || 1); out.forEach(o => o.m = Math.min(1, o.m / p90));
    out.step = step; return out;
  }
  function bestWindow(motion, dur, L) {
    if (!motion || L >= dur) return 0;
    const step = motion.step, k = Math.max(1, Math.round(L / step)); let best = 0, bs = -1;
    for (let i = 0; i + k <= motion.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += motion[i + j].m; if (s > bs) { bs = s; best = i; } }
    return Math.min(dur - L, best * step);
  }
  // The three suggestions the sheet offers. target = seconds the shot should last in the edit.
  function suggestions(dur, motion, target) {
    const keep = { id: 'keep', label: 'Keep as is', in: 0, out: dur, speed: 1, note: 'Uses the whole clip at normal speed.' };
    const ratio = dur / target;
    const speed = { id: 'speed', label: 'Speed up', in: 0, out: dur, speed: Math.min(4, Math.max(1, Math.round(ratio * 20) / 20)), note: '' };
    speed.note = `Plays the whole clip at ${speed.speed}× so it lasts about ${r1(dur / speed.speed)} s.`;
    const L = Math.min(dur, target * Math.min(1.6, Math.max(1, ratio)));
    let st = r1(bestWindow(motion, dur, L)), en = r1(st + L);
    if (motion && motion.length) { // trim dead air at both ends of the window, but never below the target length
      const at = t => motion[Math.max(0, Math.min(motion.length - 1, Math.floor(t / motion.step)))].m, stp = motion.step;
      while (en - st - stp >= target && at(st) < 0.15) st = r1(st + stp);
      while (en - st - stp >= target && at(en - stp) < 0.15) en = r1(en - stp);
    }
    const Lc = en - st, cut = { id: 'cut', label: 'Smart cut', in: st, out: en, speed: r1(Lc / target) > 1.05 ? r1(Lc / target) : 1, note: '' };
    cut.note = `Keeps the most active ${r1(Lc)} s (from ${st} s)${cut.speed > 1 ? ` at ${cut.speed}×` : ''} and drops the rest.`;
    const pick = dur <= target * 1.12 ? keep : ratio <= 1.7 ? speed : cut;
    return { keep, speed, cut, pick };
  }
  const outLen = p => Math.max(0.1, (p.out - p.in) / p.speed);

  // ---------- pre-cut on the phone (trim + speed + downscale into a small file, real time) ----------
  async function precut(video, p, onProg, cancelled) {
    const W = 1080, H = 1920, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx = cv.getContext('2d'); const stream = cv.captureStream(30);
    const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!mimeType) throw new Error('This browser cannot shrink video. Film in 1080p instead.');
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 9e6 }), chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    video.pause(); video.muted = true; video.loop = false; video.currentTime = p.in; await once(video, 'seeked');
    video.playbackRate = Math.min(16, p.speed);
    const done = new Promise(res => rec.onstop = res); rec.start(500);
    const draw = () => {
      const vw = video.videoWidth, vh = video.videoHeight, s = Math.max(W / vw, H / vh), dw = vw * s, dh = vh * s;
      cx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
    };
    await video.play();
    await new Promise((res, rej) => {
      const tick = () => {
        if (cancelled()) { rec.stop(); return rej(new Error('cancelled')); }
        draw(); onProg && onProg(Math.min(1, (video.currentTime - p.in) / (p.out - p.in)));
        if (video.currentTime >= p.out - 0.03 || video.ended) return res();
        requestAnimationFrame(tick);
      }; tick();
    });
    video.pause(); rec.stop(); await done;
    return new File([new Blob(chunks, { type: mimeType.split(';')[0] })], 'precut.' + (mimeType.includes('mp4') ? 'mp4' : 'webm'), { type: mimeType.split(';')[0] });
  }

  // ---------- upload with a real progress bar ----------
  async function uploadWithProgress(path, file, onProg) {
    const { data: s, error } = await X.sb.storage.from('reels').createSignedUploadUrl(path, { upsert: true });
    if (error) throw error;
    await new Promise((res, rej) => {
      const xhr = new XMLHttpRequest(); xhr.open('PUT', s.signedUrl);
      xhr.setRequestHeader('x-upsert', 'true');
      const fd = new FormData(); fd.append('cacheControl', '3600'); fd.append('', file);
      xhr.upload.onprogress = e => e.lengthComputable && onProg(e.loaded / e.total);
      xhr.onload = () => xhr.status < 300 ? res() : rej(new Error(`Upload failed (${xhr.status}) ${String(xhr.responseText).slice(0, 120)}`));
      xhr.onerror = () => rej(new Error('Network error during upload'));
      xhr.send(fd);
    });
  }

  // ---------- overlay plumbing ----------
  function overlay(html) {
    const el = document.createElement('div'); el.className = 'sheet'; el.innerHTML = `<div class="sheet-card">${html}</div>`;
    document.body.appendChild(el); document.body.classList.add('noscroll');
    el.close = () => { el.remove(); document.body.classList.remove('noscroll'); };
    return el;
  }

  // ---------- the clip sheet ----------
  function openSheet(idea, slot, file) {
    const S = {
      file, objUrl: URL.createObjectURL(file), dur: 0, w: 0, h: 0, motion: null, sug: null, cancel: false, busy: false,
      p: { in: 0, out: 10, speed: 1, mute: true }, target: +slot.seconds || 10,
      narr: { on: !!idea.edit?.narrator?.on, text: idea.edit?.narrator?.text || '' },
      shrink: file.size > 150e6,
    };
    const el = overlay(`
      <div class="sheet-h"><div><h2>${esc(slot.label || slot.id)}</h2><p class="sub" id="sx-info">Reading your clip…</p></div><button class="btn small" data-x="close">Cancel</button></div>
      <div class="sx-stage"><video id="sx-v" playsinline muted></video></div>
      <div class="sx-note" id="sx-note"></div>
      <div class="sx-graph" id="sx-graph"></div>
      <div class="sx-sliders">
        <label>Start <b id="sx-in-l"></b><input type="range" id="sx-in" min="0" max="10" step="0.1" value="0"></label>
        <label>End <b id="sx-out-l"></b><input type="range" id="sx-out" min="0" max="10" step="0.1" value="10"></label>
      </div>
      <div class="sx-row"><span class="sub">Suggested</span><div class="chips" id="sx-sug"></div></div>
      <div class="sx-row"><span class="sub">Speed</span><div class="chips" id="sx-speed"></div></div>
      <div class="sx-row"><label class="sw"><input type="checkbox" id="sx-mute" checked> Mute original sound <span class="sub">(sounds are added in Instagram)</span></label></div>
      <div class="sx-narr">
        <label class="sw"><input type="checkbox" id="sx-nOn"> Add a narrator in my own voice</label>
        <div id="sx-nBox" hidden>
          <textarea id="sx-nTxt" rows="4" placeholder="What should the voice say? Keep it to what fits in the shot."></textarea>
          <p class="sub" id="sx-nInfo"></p>
        </div>
      </div>
      <label class="sw" id="sx-shrinkRow"><input type="checkbox" id="sx-shrink"> Shrink on this phone first <span class="sub" id="sx-shrinkInfo"></span></label>
      <div class="sx-out" id="sx-out-sum"></div>
      <div class="bar-prog" id="sx-prog" hidden><i></i><span></span></div>
      <div class="row"><button class="btn primary" id="sx-go" disabled>Upload edited clip</button></div>`);
    el.firstChild.classList.add('auto');   // the app decides the edit; no controls are shown
    const q = s => el.querySelector(s), v = q('#sx-v');
    v.src = S.objUrl;
    const refresh = () => {
      const p = S.p;
      q('#sx-in').value = p.in; q('#sx-out').value = p.out;
      q('#sx-in-l').textContent = r1(p.in) + ' s'; q('#sx-out-l').textContent = r1(p.out) + ' s';
      q('#sx-out-sum').innerHTML = `Result: <b>${r1(outLen(p))} s</b> at ${p.speed}× · 1080×1920 · target ${r1(S.target)} s` + (Math.abs(outLen(p) - S.target) > S.target * 0.35 ? ' <span class="warn">far from the target length</span>' : '');
      q('#sx-speed').innerHTML = [1, 1.25, 1.5, 2, 3].map(x => `<button class="chip" aria-pressed="${p.speed === x}" data-sp="${x}">${x}×</button>`).join('');
      if (S.sug) q('#sx-sug').innerHTML = ['cut', 'speed', 'keep'].map(k => `<button class="chip" data-sug="${k}" aria-pressed="${S.sug.pick.id === k && S.applied === k}">${S.sug[k].label}</button>`).join('');
      v.playbackRate = Math.min(16, p.speed);
      const g = q('#sx-graph');
      if (S.motion) {
        const m = S.motion, W = 300, bw = W / m.length;
        g.innerHTML = `<svg viewBox="0 0 ${W} 44" preserveAspectRatio="none">${m.map((o, i) => `<rect x="${i * bw + .4}" y="${44 - 3 - o.m * 38}" width="${bw - .8}" height="${3 + o.m * 38}" rx="1" class="${o.t >= p.in - 1e-6 && o.t < p.out ? 'on' : ''}"/>`).join('')}</svg><span class="sub">Activity in your clip. Bright = what stays.</span>`;
      }
      const big = S.file.size > BUCKET_MAX;
      q('#sx-shrink').checked = S.shrink || big; q('#sx-shrink').disabled = big;
      q('#sx-shrinkInfo').textContent = big ? `(needed: ${MB(S.file.size)} is over the 500 MB limit)` : `(${MB(S.file.size)} now, about ${MB(Math.max(2e6, 1.1e6 * outLen(p)))} after)`;
      const vc = voice();
      q('#sx-nBox').hidden = !S.narr.on;
      q('#sx-nInfo').innerHTML = vc ? 'Your cloned voice is ready. The render engine reads this text in your voice.' : 'No voice yet. <button class="btn small" data-x="voice">Record my voice</button> (20 s, once).';
    };
    v.addEventListener('timeupdate', () => { if (!S.busy && v.currentTime >= S.p.out - 0.02) v.currentTime = S.p.in; });
    v.addEventListener('loadedmetadata', async () => {
      S.dur = v.duration; S.w = v.videoWidth; S.h = v.videoHeight;
      S.p.in = 0; S.p.out = r1(S.dur);
      q('#sx-in').max = q('#sx-out').max = r1(S.dur);
      const bits = [`${r1(S.dur)} s`, MB(S.file.size), `${S.w}×${S.h}`];
      const flags = [];
      if (Math.max(S.w, S.h) > 2000) flags.push('4K: will be reduced to 1080p');
      if (S.dur > S.target * 1.5) flags.push(`long: the shot only needs ~${r1(S.target)} s`);
      q('#sx-info').innerHTML = bits.join(' · ') + (flags.length ? `<br><span class="warn">${flags.join(' · ')}</span>` : '');
      q('#sx-note').textContent = 'Analysing which parts of your clip have action…';
      S.sug = suggestions(S.dur, null, S.target); S.applied = null; refresh();
      v.play().catch(() => {});
      const motion = await analyzeMotion(v, S.dur, f => q('#sx-note').textContent = `Analysing your clip… ${Math.round(f * 100)}%`, () => S.cancel);
      if (!motion) return;
      S.motion = motion; S.sug = suggestions(S.dur, motion, S.target);
      const pk = S.sug.pick; Object.assign(S.p, { in: pk.in, out: pk.out, speed: pk.speed }); S.applied = pk.id;
      q('#sx-note').innerHTML = `<b>Suggested edit:</b> ${esc(pk.note)}`;
      q('#sx-go').disabled = false; v.currentTime = S.p.in; v.play().catch(() => {}); refresh();
      setTimeout(() => { if (!S.cancel && !S.busy) q('#sx-go').click(); }, 900);   // auto-apply the suggestion
    }, { once: true });
    v.addEventListener('error', () => { q('#sx-info').innerHTML = '<span class="warn">This phone cannot preview that format. You can still upload it; the engine will edit it with the defaults.</span>'; S.sug = null; q('#sx-go').disabled = false; setTimeout(() => { if (!S.cancel && !S.busy) q('#sx-go').click(); }, 900); });

    q('#sx-nOn').checked = S.narr.on; q('#sx-nTxt').value = S.narr.text;
    q('#sx-in').oninput = e => { S.p.in = Math.min(+e.target.value, S.p.out - 0.5); S.applied = null; v.currentTime = S.p.in; refresh(); };
    q('#sx-out').oninput = e => { S.p.out = Math.max(+e.target.value, S.p.in + 0.5); S.applied = null; refresh(); };
    q('#sx-mute').onchange = e => S.p.mute = e.target.checked;
    q('#sx-nOn').onchange = e => { S.narr.on = e.target.checked; refresh(); };
    q('#sx-nTxt').oninput = e => S.narr.text = e.target.value;
    q('#sx-shrink').onchange = e => S.shrink = e.target.checked;
    el.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.x === 'close') { S.cancel = true; URL.revokeObjectURL(S.objUrl); el.close(); }
      if (b.dataset.x === 'voice') { openVoice(() => refresh()); }
      if (b.dataset.sp) { S.p.speed = +b.dataset.sp; S.applied = null; refresh(); }
      if (b.dataset.sug && S.sug) { const s = S.sug[b.dataset.sug]; Object.assign(S.p, { in: s.in, out: s.out, speed: s.speed }); S.applied = b.dataset.sug; q('#sx-note').innerHTML = `<b>${esc(s.label)}:</b> ${esc(s.note)}`; v.currentTime = S.p.in; refresh(); }
    });
    q('#sx-go').onclick = async () => {
      const goBtn = q('#sx-go'); goBtn.disabled = true; S.busy = true;
      const prog = q('#sx-prog'), bar = prog.querySelector('i'), lab = prog.querySelector('span'); prog.hidden = false;
      const set = (f, t) => { bar.style.width = Math.round(f * 100) + '%'; lab.textContent = t; };
      try {
        let file = S.file, plan = { in: r1(S.p.in), out: r1(S.p.out), speed: S.p.speed, mute: S.p.mute, source: { dur: r1(S.dur), w: S.w, h: S.h, bytes: S.file.size } };
        if (q('#sx-shrink').checked && S.dur) {
          set(0, 'Shrinking on your phone. Keep this screen open…');
          file = await precut(v, S.p, f => set(f, `Shrinking… ${Math.round(f * 100)}%`), () => S.cancel);
          plan = { ...plan, in: 0, out: r1(outLen(S.p)), speed: 1, precut: true };
        }
        const ext = (file.name.split('.').pop() || 'mov').toLowerCase();
        const path = `clips/${idea.id}/${slot.id}-${Date.now()}.${ext}`;
        set(0, `Uploading ${MB(file.size)}…`);
        await uploadWithProgress(path, file, f => set(f, `Uploading ${MB(file.size)}… ${Math.round(f * 100)}%`));
        const row = { idea_id: idea.id, slot: slot.id, path, plan };
        let r = await X.sb.from('clips').insert(row);
        if (r.error && /plan/.test(r.error.message)) r = await X.sb.from('clips').insert({ idea_id: idea.id, slot: slot.id, path });
        if (r.error) throw r.error;
        if (S.narr.on !== !!idea.edit?.narrator?.on || S.narr.text !== (idea.edit?.narrator?.text || '')) {
          const edit = { ...(idea.edit || {}), narrator: { on: S.narr.on, text: S.narr.text.trim() } };
          idea.edit = edit; await X.patchIdea(idea.id, { edit });
        }
        if (idea.status === 'picked') await X.patchIdea(idea.id, { status: 'filming' });
        set(1, 'Done'); X.toast('Uploaded. Editing starts within the hour'); URL.revokeObjectURL(S.objUrl); el.close(); X.load();
      } catch (err) {
        if (err.message === 'cancelled') return;
        S.busy = false; goBtn.disabled = false; prog.hidden = true; X.toast(err.message || 'Upload failed');
      }
    };
    refresh();
  }

  // ---------- the voice sheet: record or upload a 20 s sample once ----------
  const SCRIPT = 'Read this out loud, like you are telling a friend. "Last week I filmed one clip, and the app turned it into three versions with different hooks. I did not edit a single second. I just picked the best one, added a sound, and posted it. It still feels strange how easy that was."';
  function openVoice(onDone) {
    const vc = voice();
    const el = overlay(`
      <div class="sheet-h"><div><h2>Your narrator voice</h2><p class="sub">Record about 20 seconds once. The render engine clones your voice from it (free, open-source Chatterbox, on your own computer).</p></div><button class="btn small" data-x="close">Close</button></div>
      <p class="sx-script">${esc(SCRIPT)}</p>
      <div class="vu"><i id="vu"></i></div>
      <p class="sub" id="vs">${vc ? `A voice sample is saved (${vc.seconds ? Math.round(vc.seconds) + ' s, ' : ''}${esc((vc.updated_at || '').slice(0, 10))}). Record again to replace it.` : 'No sample yet.'}</p>
      <audio id="va" controls hidden></audio>
      <div class="row"><button class="btn primary" id="vr">Start recording</button><label class="btn">Upload audio instead<input type="file" id="vf" accept="audio/*,video/*" hidden></label><button class="btn ok" id="vsave" hidden>Save this voice</button></div>
      <p class="sub">Only clone your own voice. Quiet room, phone about a hand away.</p>`);
    const q = s => el.querySelector(s); let rec, chunks = [], stream, t0, timer, blob = null, secs = 0, ac, raf;
    const stop = () => { clearInterval(timer); cancelAnimationFrame(raf); stream && stream.getTracks().forEach(t => t.stop()); ac && ac.close().catch(() => {}); };
    const setBlob = (b, s) => { blob = b; secs = s; const a = q('#va'); a.src = URL.createObjectURL(b); a.hidden = false; q('#vsave').hidden = false; q('#vs').textContent = `Recorded ${Math.round(s)} s. Listen, then save.`; };
    q('#vr').onclick = async () => {
      if (rec && rec.state === 'recording') { rec.stop(); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
      } catch (e) { X.toast('Allow microphone access to record'); return; }
      const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'], mt = types.find(t => MediaRecorder.isTypeSupported(t));
      rec = new MediaRecorder(stream, mt ? { mimeType: mt } : {}); chunks = [];
      rec.ondataavailable = e => e.data.size && chunks.push(e.data);
      rec.onstop = () => { stop(); q('#vr').textContent = 'Record again'; setBlob(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), (Date.now() - t0) / 1000); };
      ac = new (window.AudioContext || window.webkitAudioContext)(); const an = ac.createAnalyser(); ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => { an.getByteTimeDomainData(buf); let m = 0; for (const x of buf) m = Math.max(m, Math.abs(x - 128)); q('#vu').style.width = Math.min(100, m * 1.6) + '%'; raf = requestAnimationFrame(tick); }; tick();
      t0 = Date.now(); rec.start(); q('#vr').textContent = 'Stop (aim for 20 s)';
      timer = setInterval(() => { const s = (Date.now() - t0) / 1000; q('#vs').textContent = `Recording… ${Math.round(s)} s`; if (s > 45) rec.stop(); }, 250);
    };
    q('#vf').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const a = document.createElement('audio'); a.src = URL.createObjectURL(f); await once(a, 'loadedmetadata').catch(() => {});
      setBlob(f, a.duration || 0);
    };
    q('#vsave').onclick = async () => {
      if (!blob) return; if (secs && secs < 8) { X.toast('Too short. Aim for 15-30 s'); return; }
      q('#vsave').disabled = true; q('#vs').textContent = 'Saving…';
      const ext = /mp4|m4a|aac/.test(blob.type) ? 'm4a' : /mpeg|mp3/.test(blob.type) ? 'mp3' : /wav/.test(blob.type) ? 'wav' : 'webm';
      const path = `voice/ref-${Date.now()}.${ext}`;
      try {
        await uploadWithProgress(path, blob instanceof File ? blob : new File([blob], 'ref.' + ext, { type: blob.type }), () => {});
        const { error } = await X.sb.from('status').upsert({ key: 'voice', value: { path, seconds: secs, mime: blob.type, updated_at: new Date().toISOString() }, updated_at: new Date().toISOString() });
        if (error) throw error;
        X.toast('Voice saved'); el.close(); X.load().then(() => onDone && onDone());
      } catch (err) { q('#vsave').disabled = false; q('#vs').textContent = err.message || 'Could not save'; }
    };
    el.addEventListener('click', e => { if (e.target.closest('[data-x="close"]')) { stop(); el.close(); } });
  }

  function voiceCard() {
    const vc = voice();
    return `<section class="card"><h2>Narrator voice</h2>
      <p class="sub">${vc ? `Your voice sample is saved${vc.seconds ? ` (${Math.round(vc.seconds)} s)` : ''}. Switch the narrator on per clip when you upload.` : 'Optional. Record 20 s of your own voice once, then any clip can get a narrator that sounds like you.'}</p>
      <div class="row"><button class="btn ${vc ? '' : 'primary'}" data-act="voice">${vc ? 'Re-record my voice' : 'Record my voice'}</button></div></section>`;
  }

  return { init, openSheet, openVoice, voiceCard, suggestions, analyzeMotion, bestWindow, uploadWithProgress, r1, MB, esc, once, BUCKET_MAX };
})();
