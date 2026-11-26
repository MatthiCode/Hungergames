/* Client : réseau, entrées, prédiction, rendu. */
(() => {
  'use strict';
  const { C, COLORS, WEAPONS, itemName, mulberry32, angDiff, genMap, inBush, inWater, stepMove } = HG;
  const $ = id => document.getElementById(id);
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);

  /* ================= Audio (sons synthétisés) ================= */
  const A = {
    ctx: null, muted: false, noise: null,
    init() {
      if (this.ctx) return;
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        const n = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate), d = n.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        this.noise = n;
      } catch (e) { this.ctx = null; }
    },
    tone(f0, f1, dur, type = 'sine', vol = 0.2, delay = 0) {
      if (!this.ctx || this.muted) return;
      const t = this.ctx.currentTime + delay, o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + dur + 0.05);
    },
    nz(dur, vol, freq, type = 'lowpass', delay = 0) {
      if (!this.ctx || this.muted || !this.noise) return;
      const t = this.ctx.currentTime + delay, s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
      s.buffer = this.noise; f.type = type; f.frequency.value = freq;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f).connect(g).connect(this.ctx.destination); s.start(t, Math.random()); s.stop(t + dur + 0.05);
    },
    play(n, v = 1) {
      switch (n) {
        case 'swing': this.nz(0.13, 0.18 * v, 1800, 'bandpass'); break;
        case 'hit': this.tone(190, 55, 0.14, 'square', 0.16 * v); this.nz(0.09, 0.2 * v, 900); break;
        case 'shot': this.tone(720, 260, 0.14, 'triangle', 0.12 * v); this.nz(0.06, 0.08 * v, 3000, 'highpass'); break;
        case 'pick': this.tone(520, 880, 0.1, 'sine', 0.14 * v); this.tone(880, 1320, 0.1, 'sine', 0.1 * v, 0.07); break;
        case 'cannon': this.tone(95, 32, 1.4, 'sine', 0.55); this.nz(0.8, 0.45, 260); break;
        case 'thunder': this.nz(1.5, 0.6 * v, 220); this.tone(60, 28, 1.0, 'sine', 0.35 * v); break;
        case 'horn': this.tone(196, 196, 0.7, 'sawtooth', 0.1); this.tone(294, 294, 0.7, 'sawtooth', 0.08); break;
        case 'gong': this.tone(110, 108, 2.0, 'sine', 0.4); this.tone(220, 218, 1.6, 'triangle', 0.15); this.nz(0.4, 0.2, 500); break;
        case 'howl': this.tone(300, 520, 0.9, 'sine', 0.14); this.tone(520, 280, 0.9, 'sine', 0.12, 0.9); break;
        case 'hurt': this.tone(240, 90, 0.2, 'sawtooth', 0.14); break;
        case 'drop': this.tone(140, 50, 0.5, 'sine', 0.35 * v); this.nz(0.3, 0.3 * v, 600); break;
        case 'empty': this.tone(300, 260, 0.05, 'square', 0.05); break;
        case 'beep': this.tone(660, 660, 0.08, 'sine', 0.12); break;
        case 'tick': this.tone(440, 440, 0.06, 'sine', 0.1); break;
      }
    },
  };

  /* ================= Réseau + écrans ================= */
  let ws = null, uiState = 'menu', lastRoom = null, myId = 0, pingMs = 0;
  const screens = { menu: $('menu'), lobby: $('lobby'), results: $('results') };
  const cv = $('cv'), ctx = cv.getContext('2d');

  function show(state) {
    uiState = state;
    $('menu').classList.toggle('hidden', state !== 'menu');
    $('lobby').classList.toggle('hidden', state !== 'lobby');
    $('results').classList.toggle('hidden', state !== 'results');
    cv.classList.toggle('hidden', state !== 'game' && state !== 'results');
  }

  function connect(then) {
    if (ws && ws.readyState === 1) return then();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = then;
    ws.onmessage = e => onMsg(JSON.parse(e.data));
    ws.onclose = () => { if (uiState !== 'menu' || myId) $('lost').classList.remove('hidden'); else $('menuErr').textContent = 'Connexion au serveur impossible.'; };
    setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', ts: performance.now() })); }, 2000);
  }
  const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const getName = () => { const n = $('name').value.trim() || 'Tribut'; try { localStorage.setItem('hg-name', n); } catch (e) {} return n; };

  try { $('name').value = localStorage.getItem('hg-name') || ''; } catch (e) {}
  const qs = new URLSearchParams(location.search);
  if (qs.get('room')) $('code').value = qs.get('room').toUpperCase().slice(0, 4);

  $('btnCreate').onclick = () => { A.init(); $('menuErr').textContent = ''; connect(() => send({ t: 'create', name: getName() })); };
  $('btnJoin').onclick = () => {
    A.init(); $('menuErr').textContent = '';
    const code = $('code').value.trim();
    if (code.length < 4) return ($('menuErr').textContent = 'Entre le code à 4 lettres.');
    connect(() => send({ t: 'join', name: getName(), code }));
  };
  $('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnJoin').click(); });
  $('name').addEventListener('keydown', e => { if (e.key === 'Enter') ($('code').value ? $('btnJoin') : $('btnCreate')).click(); });
  $('btnStart').onclick = () => { A.init(); send({ t: 'start' }); };
  $('btnBack').onclick = () => { G.active = false; show('lobby'); };
  $('btnCopy').onclick = () => {
    const link = `${location.origin}/?room=${lastRoom.code}`;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(
      () => { $('btnCopy').textContent = 'Lien copié ✔'; setTimeout(() => ($('btnCopy').textContent = "Copier le lien d'invitation"), 1800); },
      () => prompt("Copie ce lien et envoie-le à ton pote :", link));
  };

  function renderLobby(r) {
    lastRoom = r;
    $('roomCode').textContent = r.code;
    $('playerList').innerHTML = r.players.map(p =>
      `<li><span class="dot" style="background:${p.color}"></span>${esc(p.name)}${p.id === r.host ? '<span class="tag">hôte</span>' : ''}${p.id === myId ? '<span class="tag">toi</span>' : ''}</li>`).join('');
    const host = r.host === myId, n = r.players.length;
    $('btnStart').classList.toggle('hidden', !host);
    $('btnStart').textContent = n >= 2 ? 'Lancer les Jeux' : 'Explorer l\'arène seul (test)';
    $('lobbyHint').textContent = host ? (n < 2 ? 'Ton pote n\'est pas encore là. Envoie-lui le code ou le lien !' : `${n} tributs prêts.`) : "En attente du lancement par l'hôte...";
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function onMsg(m) {
    switch (m.t) {
      case 'joined': myId = m.id; show('lobby'); break;
      case 'room': if (uiState === 'menu' || uiState === 'lobby' || uiState === 'results' || uiState === 'game') { renderLobby(m); } break;
      case 'error': $('menuErr').textContent = m.text; break;
      case 'start': startGame(m); break;
      case 's': onSnap(m); break;
      case 'msg': onText(m); break;
      case 'dead': G.dead = m; A.play('hurt'); break;
      case 'over': onOver(m); break;
      case 'pong': pingMs = Math.round(performance.now() - m.ts); break;
    }
  }

  /* ================= État de jeu ================= */
  const G = {
    active: false, you: 0, map: null, snaps: [], last: null,
    me: { x: 0, y: 0, st: 100, slock: false, spd: 1 }, view: { x: 0, y: 0 }, cam: { x: 0, y: 0 },
    pending: [], seq: 0, acc: 0, aim: 0, mouse: { x: 0, y: 0, down: false }, keys: {},
    parts: [], texts: [], swings: [], logs: [], anns: [], tips: [], shake: 0, flash: 0, hurtFlash: 0, localCd: 0,
    dead: null, prevHp: 100, bolts: [], rain: [], t: 0, W: 0, H: 0, zoom: 1, dpr: 1, rustle: {}, lastSpec: 0,
  };
  let grass = null;

  function makeGrass() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#2d4a27'; g.fillRect(0, 0, 256, 256);
    const rnd = mulberry32(7);
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(${20 + rnd() * 30},${50 + rnd() * 40},${20 + rnd() * 20},0.22)`; g.beginPath(); g.arc(rnd() * 256, rnd() * 256, 14 + rnd() * 30, 0, TAU); g.fill(); }
    for (let i = 0; i < 700; i++) { g.fillStyle = `rgba(${40 + rnd() * 50},${90 + rnd() * 70},${30 + rnd() * 30},${0.25 + rnd() * 0.3})`; g.fillRect(rnd() * 256, rnd() * 256, 1.5, 3 + rnd() * 3); }
    return ctx.createPattern(c, 'repeat');
  }

  function startGame(m) {
    G.you = m.you; myId = m.you;
    G.map = genMap(m.seed);
    for (const b of G.map.bushes) { // feuillage de buisson
      const r = mulberry32(b.id * 977 + m.seed); b.blobs = [];
      for (let i = 0; i < 13; i++) { const a = r() * TAU, d = Math.sqrt(r()) * b.r * 0.5; b.blobs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: b.r * (0.46 + r() * 0.26), l: r() }); }
    }
    for (const s of G.map.solids) if (s.k === 'rock') {
      const r = mulberry32(Math.floor(s.v * 1e6)); s.pts = [];
      for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU, d = s.r * (0.82 + r() * 0.3); s.pts.push([Math.cos(a) * d, Math.sin(a) * d]); }
    }
    Object.assign(G, { snaps: [], last: null, pending: [], seq: 0, acc: 0, parts: [], texts: [], swings: [], logs: [], anns: [], tips: [], bolts: [], rustle: {},
      dead: null, prevHp: 100, shake: 0, flash: 0, hurtFlash: 0, localCd: 0, active: true, first: true });
    if (!grass) grass = makeGrass();
    show('game');
    resize();
  }

  function onOver(m) {
    const w = m.winner;
    $('resTitle').textContent = w ? (w.id === G.you ? '👑 Tu remportes les Jeux !' : `👑 ${w.name} remporte les Jeux`) : "Personne ne survit à l'arène";
    $('resTable').innerHTML = m.ranking.map(r =>
      `<tr><td>#${r.place || '-'}</td><td><span style="color:${r.color}">●</span> ${esc(r.name)}${r.id === G.you ? ' (toi)' : ''}</td><td>${r.kills} ☠</td></tr>`).join('');
    show('results');
    if (w && w.id === G.you) A.play('horn');
  }

  function onText(m) {
    const t = performance.now();
    if (m.k === 'ann') { G.anns.unshift({ text: m.text, t }); G.anns.length = Math.min(G.anns.length, 3); A.play(/parachute|muttation/.test(m.text) ? 'horn' : 'beep'); }
    else if (m.k === 'log') G.logs.unshift({ text: m.text, t });
    else if (m.k === 'tip') G.tips.unshift({ text: m.text, t });
    if (G.logs.length > 6) G.logs.length = 6;
  }

  function onSnap(s) {
    if (!G.active) return;
    const now = performance.now();
    G.snaps.push({ t: now, s }); if (G.snaps.length > 12) G.snaps.shift();
    G.last = s;
    const m = s.me;
    G.me.hp = m.hp; G.me.spd = m.spd; G.me.st = m.st; G.me.slock = m.sl;
    if (m.al) {
      G.me.x = m.x; G.me.y = m.y;
      G.pending = G.pending.filter(c => c.seq > m.ack);
      for (const c of G.pending) stepMove(G.me, c.mx, c.my, c.sprint, c.dt, G.map);
      if (m.cd > G.localCd) G.localCd = m.cd;
    } else { G.me.x = m.x; G.me.y = m.y; G.view.x = m.x; G.view.y = m.y; }
    if (G.first) { G.view.x = G.me.x; G.view.y = G.me.y; G.cam.x = G.me.x; G.cam.y = G.me.y; G.first = false; }
    if (m.hp < G.prevHp - 0.5 && m.al) { G.hurtFlash = Math.min(1, G.hurtFlash + (G.prevHp - m.hp) / 40 + 0.25); if (G.prevHp - m.hp > 3) A.play('hurt'); }
    G.prevHp = m.hp;
    for (const b of s.ru) G.rustle[b] = now;
    for (const f of s.fx) onFx(f);
  }

  function onFx(f) {
    const [k, x, y, a, b, c] = f;
    const d = Math.hypot(x - G.me.x, y - G.me.y), vol = clamp(1 - d / 900, 0.12, 1);
    switch (k) {
      case 'swing': if (b !== G.you) { G.swings.push({ x, y, a, w: c, t: performance.now(), id: b }); A.play('swing', vol); } break;
      case 'shot': if (b !== G.you) A.play('shot', vol); break;
      case 'hit':
        if (c === 'k') { burst(x, y, 12, '#8a1d1d', 120); break; }
        burst(x, y, c === 'p' ? 8 : 6, c === 'p' ? '#b32020' : '#7a1111', 140);
        if (a > 0) G.texts.push({ x, y: y - 20, text: String(a), t: performance.now(), c: c === 'p' ? '#ffb4a0' : '#ffe28a' });
        A.play('hit', vol); if (d < 40) G.shake = Math.max(G.shake, 6);
        break;
      case 'pick': burst(x, y, 10, '#ffe08a', 90); A.play('pick', vol); break;
      case 'cannon': A.play('cannon'); G.shake = Math.max(G.shake, 4); break;
      case 'death': burst(x, y, 26, '#a31616', 220); break;
      case 'bolt': G.flash = Math.max(G.flash, d < 500 ? 0.9 : 0.35); A.play('thunder', clamp(1 - d / 1500, 0.25, 1)); G.shake = Math.max(G.shake, d < 300 ? 12 : 3); burst(x, y, 24, '#fff7b0', 260); break;
      case 'land': A.play('drop', clamp(1 - d / 1500, 0.3, 1)); burst(x, y, 30, '#e5b94a', 200); break;
      case 'howl': A.play('howl'); break;
      case 'gong': A.play('gong'); break;
      case 'horn': A.play('horn'); break;
      case 'thud': burst(x, y, 4, '#c9a46a', 90); break;
    }
  }
  function burst(x, y, n, color, speed) {
    for (let i = 0; i < n; i++) { const a = Math.random() * TAU, v = rand(0.2, 1) * speed; G.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.3, 0.7), max: 0.7, c: color, s: rand(1.5, 3.5) }); }
  }

  /* ================= Entrées ================= */
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || !G.active) return;
    G.keys[e.code] = true;
    if (e.code === 'KeyE') send({ t: 'pick' });
    if (e.code === 'Tab') { e.preventDefault(); if (G.last && !G.last.me.al) send({ t: 'spec' }); }
    if (e.code === 'KeyM') { A.muted = !A.muted; }
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  });
  addEventListener('keyup', e => { G.keys[e.code] = false; });
  addEventListener('blur', () => { G.keys = {}; G.mouse.down = false; });
  cv.addEventListener('mousemove', e => { G.mouse.x = e.clientX; G.mouse.y = e.clientY; });
  cv.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    G.mouse.down = true; G.mouse.x = e.clientX; G.mouse.y = e.clientY;
    if (G.last && !G.last.me.al) send({ t: 'spec' });
  });
  addEventListener('mouseup', () => { G.mouse.down = false; });
  cv.addEventListener('contextmenu', e => e.preventDefault());

  function resize() {
    G.dpr = Math.min(2, window.devicePixelRatio || 1);
    G.W = innerWidth; G.H = innerHeight;
    cv.width = Math.floor(G.W * G.dpr); cv.height = Math.floor(G.H * G.dpr);
    G.zoom = clamp(Math.min(G.W, G.H) / 780, 0.55, 1.5);
  }
  addEventListener('resize', resize);

  /* ================= Interpolation des autres entités ================= */
  function interp(key, angleIdx) {
    const S = G.snaps;
    if (!S.length) return [];
    const rt = performance.now() - 100;
    let i = S.length - 1;
    while (i > 0 && S[i].t > rt) i--;
    const s0 = S[i], s1 = S[Math.min(i + 1, S.length - 1)];
    if (s0 === s1 || rt <= s0.t) return s0.s[key];
    const k = clamp((rt - s0.t) / (s1.t - s0.t), 0, 1);
    const prev = new Map(s0.s[key].map(r => [r[0], r]));
    return s1.s[key].map(r => {
      const o = prev.get(r[0]);
      if (!o) return r;
      const c = r.slice();
      c[1] = o[1] + (r[1] - o[1]) * k; c[2] = o[2] + (r[2] - o[2]) * k;
      if (angleIdx) c[angleIdx] = o[angleIdx] + angDiff(r[angleIdx], o[angleIdx]) * k;
      return c;
    });
  }

  /* ================= Boucle principale ================= */
  let lastTs = performance.now();
  function frame(ts) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (ts - lastTs) / 1000); lastTs = ts;
    if (!G.active || !G.last) return;
    G.t += dt;
    update(dt);
    render(dt);
  }
  requestAnimationFrame(frame);

  function update(dt) {
    const s = G.last, m = s.me;
    G.aim = Math.atan2(G.mouse.y - G.H / 2, G.mouse.x - G.W / 2);
    G.localCd = Math.max(0, G.localCd - dt);
    if (m.al && uiState === 'game') {
      G.acc += dt;
      if (G.acc >= 0.0166) {
        const k = G.keys;
        const mx = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
        const my = (k.KeyS || k.ArrowDown ? 1 : 0) - (k.KeyW || k.ArrowUp ? 1 : 0);
        const atk = G.mouse.down;
        const cmd = { t: 'in', seq: ++G.seq, dt: G.acc, mx, my, sprint: !!(k.ShiftLeft || k.ShiftRight), aim: +G.aim.toFixed(3), atk };
        G.acc = 0;
        stepMove(G.me, mx, my, cmd.sprint, cmd.dt, G.map);
        G.pending.push(cmd); if (G.pending.length > 120) G.pending.shift();
        send(cmd);
      }
      // attaque prédite localement (le serveur reste maître des dégâts)
      if (G.mouse.down && s.ph === 1 && G.localCd <= 0) {
        const W = WEAPONS[m.w];
        if (W.ranged && m.aw <= 0) { G.localCd = 0.35; A.play('empty'); }
        else {
          G.localCd = W.cd;
          if (W.ranged) { A.play('shot'); } else { G.swings.push({ x: G.view.x, y: G.view.y, a: G.aim, w: m.w, t: performance.now(), id: G.you }); A.play('swing'); }
        }
      }
      const k2 = 1 - Math.exp(-dt * 28);
      if (Math.hypot(G.me.x - G.view.x, G.me.y - G.view.y) > 150) { G.view.x = G.me.x; G.view.y = G.me.y; }
      G.view.x += (G.me.x - G.view.x) * k2; G.view.y += (G.me.y - G.view.y) * k2;
    }
    const kc = 1 - Math.exp(-dt * 10);
    G.cam.x += (G.view.x - G.cam.x) * (m.al ? 1 : kc); G.cam.y += (G.view.y - G.cam.y) * (m.al ? 1 : kc);
    G.shake = Math.max(0, G.shake - dt * 30); G.flash = Math.max(0, G.flash - dt * 2.2); G.hurtFlash = Math.max(0, G.hurtFlash - dt * 2);

    for (const p of G.parts) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; }
    G.parts = G.parts.filter(p => p.life > 0);
    // braises le long du mur de flammes, braises des incendies
    const z = s.z;
    if (z[2] > 10 && Math.random() < 0.8) {
      const ang = Math.atan2(G.cam.y - z[1], G.cam.x - z[0]) + rand(-0.5, 0.5) * Math.min(1, 700 / z[2]);
      G.parts.push({ x: z[0] + Math.cos(ang) * z[2], y: z[1] + Math.sin(ang) * z[2], vx: rand(-10, 10), vy: rand(-60, -20), life: rand(0.6, 1.2), max: 1.2, c: '#ff8a2a', s: rand(1.5, 3) });
    }
    for (const h of s.hz) if (h[1] === 1 && h[5] === 1 && Math.random() < 0.6) {
      const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * h[4];
      G.parts.push({ x: h[2] + Math.cos(a) * d, y: h[3] + Math.sin(a) * d, vx: rand(-8, 8), vy: rand(-90, -40), life: rand(0.4, 0.9), max: 0.9, c: Math.random() < 0.5 ? '#ffb02e' : '#ff5a1a', s: rand(2, 4) });
    }
    const now = performance.now();
    G.swings = G.swings.filter(w => now - w.t < 200);
    G.texts = G.texts.filter(t => now - t.t < 900);
    G.anns = G.anns.filter(a => now - a.t < 6000);
    G.logs = G.logs.filter(l => now - l.t < 9000);
    G.tips = G.tips.filter(t => now - t.t < 2600);
  }

  /* ================= Rendu ================= */
  function render() {
    const { W, H, dpr, zoom } = G, s = G.last, m = s.me, z = s.z, t = G.t, now = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
    const sh = G.shake, cx = G.cam.x + (sh ? rand(-sh, sh) / zoom : 0), cy = G.cam.y + (sh ? rand(-sh, sh) / zoom : 0);
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (W / 2 - cx * zoom), dpr * (H / 2 - cy * zoom));
    const hw = W / zoom / 2 + 80, hh = H / zoom / 2 + 80;
    const inView = (x, y, r = 0) => Math.abs(x - cx) < hw + r && Math.abs(y - cy) < hh + r;

    // sol : hors arène (force-field) puis herbe
    ctx.fillStyle = '#040604'; ctx.fillRect(cx - hw, cy - hh, hw * 2, hh * 2);
    ctx.fillStyle = grass; ctx.beginPath(); ctx.arc(0, 0, C.ARENA_R, 0, TAU); ctx.fill();
    const edge = ctx.createRadialGradient(0, 0, C.ARENA_R - 220, 0, 0, C.ARENA_R);
    edge.addColorStop(0, 'rgba(0,0,0,0)'); edge.addColorStop(1, 'rgba(0,10,0,0.55)');
    ctx.fillStyle = edge; ctx.beginPath(); ctx.arc(0, 0, C.ARENA_R, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(120,220,255,${0.35 + Math.sin(t * 2) * 0.1})`; ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(0, 0, C.ARENA_R + 4, 0, TAU); ctx.stroke();

    // plateforme de la corne d'abondance
    ctx.fillStyle = 'rgba(150,140,115,0.35)'; ctx.beginPath(); ctx.arc(0, 0, 250, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(210,190,130,0.35)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, 250, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 238, 0, TAU); ctx.stroke();
    for (const sp of G.map.spawns) { ctx.fillStyle = 'rgba(190,175,130,0.5)'; ctx.beginPath(); ctx.arc(sp.x, sp.y, 26, 0, TAU); ctx.fill(); ctx.strokeStyle = 'rgba(80,70,40,0.6)'; ctx.lineWidth = 2; ctx.stroke(); }

    // mares
    for (const p of G.map.ponds) {
      if (!inView(p.x, p.y, p.r)) continue;
      ctx.fillStyle = '#1f5b7a'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(90,170,210,0.45)'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 0.86, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(200,235,255,0.35)'; ctx.lineWidth = 2;
      for (let i = 0; i < 2; i++) { const k = ((((t * 0.25 + i * 0.5 + p.x * 0.01) % 1) + 1) % 1); ctx.globalAlpha = 1 - k; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.15 + k * 0.7), 0, TAU); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }

    // objets au sol
    for (const it of s.it) {
      if (!inView(it[2], it[3])) continue;
      drawItem(it[1], it[2], it[3], t);
    }

    // dangers au sol
    for (const h of s.hz) if (inView(h[2], h[3], h[4])) drawHazard(h, t);

    // corne d'abondance
    drawHorn(t);

    // muttations
    for (const mu of interp('mu', 3)) if (inView(mu[1], mu[2])) drawMutt(mu, t);

    // joueurs
    const others = interp('p', 3);
    for (const p of others) if (inView(p[1], p[2])) drawPlayer(p[1], p[2], p[3], p[5], COLORS[(playerColor(p[0]))] || '#ccc', playerName(p[0]), p[4], p[6], p[0], t, false);
    const myFlags = (m.hid ? 1 : 0) | (G.hurtFlash > 0.3 ? 2 : 0) | (G.me.sprinting ? 8 : 0);
    if (m.al && !m.hid) drawPlayer(G.view.x, G.view.y, G.aim, m.w, myColor(), '', m.hp, myFlags, G.you, t, true);

    // projectiles
    for (const pr of interp('pr', 0)) {
      if (!inView(pr[1], pr[2])) continue;
      ctx.save(); ctx.translate(pr[1], pr[2]); ctx.rotate(pr[3]);
      ctx.strokeStyle = '#d8c08a'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(8, 0); ctx.stroke();
      ctx.fillStyle = '#cfd6da'; ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(6, -3.5); ctx.lineTo(6, 3.5); ctx.fill();
      ctx.restore();
    }

    // coups d'arme
    for (const w of G.swings) drawSwing(w, now);

    // arbres et rochers
    for (const sd of G.map.solids) {
      if (sd.k === 'horn' || !inView(sd.x, sd.y, sd.r * 1.4)) continue;
      if (sd.k === 'tree') drawTree(sd); else drawRock(sd);
    }

    // buissons (au-dessus des joueurs : ils cachent)
    for (const b of G.map.bushes) if (inView(b.x, b.y, b.r)) drawBush(b, t, now);
    // caché : on se voit en transparence par-dessus le feuillage (les autres, eux, ne te voient pas)
    if (m.al && m.hid) drawPlayer(G.view.x, G.view.y, G.aim, m.w, myColor(), '', m.hp, myFlags, G.you, t, true);

    // mur de flammes
    ctx.beginPath(); ctx.rect(cx - hw - 50, cy - hh - 50, hw * 2 + 100, hh * 2 + 100); ctx.arc(z[0], z[1], Math.max(1, z[2]), 0, TAU);
    ctx.fillStyle = `rgba(190,45,10,${0.3 + Math.sin(t * 5) * 0.04})`; ctx.fill('evenodd');
    ctx.lineWidth = 9; ctx.strokeStyle = `rgba(255,120,30,${0.75 + Math.sin(t * 9) * 0.15})`; ctx.beginPath(); ctx.arc(z[0], z[1], Math.max(1, z[2]), 0, TAU); ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,235,150,0.9)'; ctx.stroke();
    if (z[5] < z[2] - 2) { ctx.lineWidth = 3; ctx.setLineDash([16, 12]); ctx.lineDashOffset = -t * 20; ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.beginPath(); ctx.arc(z[3], z[4], z[5], 0, TAU); ctx.stroke(); ctx.setLineDash([]); }

    // particules et textes flottants
    for (const p of G.parts) { ctx.globalAlpha = clamp(p.life / p.max, 0, 1); ctx.fillStyle = p.c; ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s); }
    ctx.globalAlpha = 1;
    ctx.font = 'bold 15px Georgia'; ctx.textAlign = 'center';
    for (const tx of G.texts) { const k = (now - tx.t) / 900; ctx.globalAlpha = 1 - k; ctx.fillStyle = tx.c; ctx.fillText(tx.text, tx.x, tx.y - k * 28); }
    ctx.globalAlpha = 1;

    // ---------- espace écran ----------
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // météo
    if (s.wx === 2) { ctx.fillStyle = 'rgba(205,215,205,0.28)'; ctx.fillRect(0, 0, W, H); }
    if (s.wx === 1) {
      ctx.fillStyle = 'rgba(10,18,40,0.28)'; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(190,210,255,0.35)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 0; i < 140; i++) { const x = ((i * 137.5 + t * 520) % (W + 100)) - 50, y = ((i * 71.3 + t * 900) % (H + 60)) - 30; ctx.moveTo(x, y); ctx.lineTo(x - 8, y + 18); }
      ctx.stroke();
    }

    // brouillard de guerre : on ne voit que dans un rayon autour de soi
    const vr = s.vis * zoom, px = W / 2 + (G.view.x - cx) * zoom, py = H / 2 + (G.view.y - cy) * zoom;
    const fog = ctx.createRadialGradient(px, py, vr * 0.5, px, py, vr);
    fog.addColorStop(0, 'rgba(3,6,4,0)'); fog.addColorStop(1, 'rgba(3,6,4,0.97)');
    ctx.fillStyle = fog; ctx.fillRect(0, 0, W, H);

    if (G.flash > 0) { ctx.fillStyle = `rgba(255,255,235,${G.flash * 0.7})`; ctx.fillRect(0, 0, W, H); }
    if (G.hurtFlash > 0) {
      const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      v.addColorStop(0, 'rgba(180,0,0,0)'); v.addColorStop(1, `rgba(180,0,0,${G.hurtFlash * 0.7})`); ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    }

    drawHUD(s, m, cx, cy, others);
  }

  /* ---------- noms / couleurs ---------- */
  function playerColor(id) { const p = lastRoom && lastRoom.players.find(q => q.id === id); return p ? Math.max(0, COLORS.indexOf(p.color)) : 0; }
  function playerName(id) { const p = lastRoom && lastRoom.players.find(q => q.id === id); return p ? p.name : '?'; }
  function myColor() { return COLORS[playerColor(G.you)]; }

  /* ---------- sprites ---------- */
  function drawWeapon(w, len = 1) {
    ctx.lineCap = 'round';
    switch (w) {
      case 'knife': ctx.strokeStyle = '#5a3a1a'; ctx.lineWidth = 4; line(0, 0, 8, 0); ctx.strokeStyle = '#d5dde2'; ctx.lineWidth = 3.5; line(8, 0, 26, 0); break;
      case 'sword': ctx.strokeStyle = '#5a3a1a'; ctx.lineWidth = 4; line(-4, 0, 6, 0); ctx.strokeStyle = '#c8a24a'; ctx.lineWidth = 3; line(6, -7, 6, 7); ctx.strokeStyle = '#e4ebef'; ctx.lineWidth = 4; line(7, 0, 52, 0); break;
      case 'axe': ctx.strokeStyle = '#6b4620'; ctx.lineWidth = 4; line(-4, 0, 42, 0); ctx.fillStyle = '#8f98a0'; ctx.beginPath(); ctx.moveTo(30, 0); ctx.lineTo(42, -16); ctx.lineTo(48, -4); ctx.lineTo(48, 4); ctx.lineTo(42, 14); ctx.closePath(); ctx.fill(); break;
      case 'spear': ctx.strokeStyle = '#7a5428'; ctx.lineWidth = 3.5; line(-14, 0, 80, 0); ctx.fillStyle = '#dfe6ea'; ctx.beginPath(); ctx.moveTo(98, 0); ctx.lineTo(78, -5); ctx.lineTo(78, 5); ctx.fill(); break;
      case 'bow': ctx.strokeStyle = '#6b4620'; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.arc(8, 0, 20, -1.15, 1.15); ctx.stroke(); ctx.strokeStyle = '#e8e0c8'; ctx.lineWidth = 1; line(8 + Math.cos(1.15) * 20, Math.sin(1.15) * 20, 8 + Math.cos(1.15) * 20, -Math.sin(1.15) * 20); break;
      case 'crossbow': ctx.strokeStyle = '#4a3014'; ctx.lineWidth = 4; line(-4, 0, 26, 0); ctx.strokeStyle = '#2d2d2d'; ctx.lineWidth = 3.5; line(16, -17, 16, 17); ctx.strokeStyle = '#e8e0c8'; ctx.lineWidth = 1; line(16, -17, 4, 0); line(4, 0, 16, 17); break;
    }
  }
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };

  function drawItem(kind, x, y, t) {
    ctx.save(); ctx.translate(x, y);
    const isW = !!WEAPONS[kind], pulse = 0.5 + Math.sin(t * 3 + x) * 0.25;
    ctx.fillStyle = isW ? `rgba(255,225,130,${0.18 + pulse * 0.2})` : `rgba(180,255,200,${0.14 + pulse * 0.16})`;
    ctx.beginPath(); ctx.arc(0, 0, 17 + pulse * 3, 0, TAU); ctx.fill();
    if (isW) { ctx.rotate(-0.8); ctx.scale(0.62, 0.62); ctx.translate(kind === 'spear' ? -40 : kind === 'sword' ? -24 : kind === 'axe' ? -20 : -8, 0); drawWeapon(kind); }
    else if (kind === 'berry') {
      ctx.fillStyle = '#6b2a8f'; for (const [dx, dy] of [[-5, 2], [4, 3], [0, -5]]) { ctx.beginPath(); ctx.arc(dx, dy, 5, 0, TAU); ctx.fill(); }
      ctx.fillStyle = '#b57ad6'; ctx.beginPath(); ctx.arc(-6, 0, 1.6, 0, TAU); ctx.fill(); ctx.fillStyle = '#3d8a35'; ctx.beginPath(); ctx.ellipse(1, -9, 5, 2.5, -0.5, 0, TAU); ctx.fill();
    } else if (kind === 'bandage') {
      ctx.fillStyle = '#f4f1e6'; ctx.fillRect(-9, -7, 18, 14); ctx.fillStyle = '#d33a3a'; ctx.fillRect(-2.5, -5.5, 5, 11); ctx.fillRect(-5.5, -2.5, 11, 5);
    } else if (kind === 'armor') {
      ctx.fillStyle = '#5b7fa8'; ctx.strokeStyle = '#c8d6e6'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-9, -8); ctx.lineTo(9, -8); ctx.lineTo(8, 3); ctx.lineTo(0, 10); ctx.lineTo(-8, 3); ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (kind === 'quiver') {
      ctx.rotate(-0.6); ctx.fillStyle = '#6b4620'; ctx.fillRect(-4, -9, 8, 18); ctx.strokeStyle = '#d8c08a'; ctx.lineWidth = 1.5; line(-2, -9, -3, -15); line(1, -9, 2, -16); line(3, -9, 5, -14);
    }
    ctx.restore();
  }

  function drawPlayer(x, y, aim, weapon, color, name, hp, fl, id, t, me) {
    const hidden = fl & 1, hurt = fl & 2;
    ctx.save(); ctx.translate(x, y);
    ctx.globalAlpha = hidden ? (me ? 0.6 : 0.55) : 1;
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(3, 5, 17, 14, 0, 0, TAU); ctx.fill();
    ctx.rotate(aim);
    // bras + arme
    ctx.save(); ctx.translate(10, 9);
    if (weapon === 'fists') { ctx.fillStyle = color; ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1.5; for (const dy of [-18, 0]) { ctx.beginPath(); ctx.arc(8, dy, 5, 0, TAU); ctx.fill(); ctx.stroke(); } }
    else { drawWeapon(weapon); ctx.fillStyle = '#e0b890'; ctx.beginPath(); ctx.arc(2, 0, 4.5, 0, TAU); ctx.fill(); }
    ctx.restore();
    // corps
    ctx.fillStyle = hurt ? '#fff' : color; ctx.strokeStyle = '#111'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(0, 0, C.PLAYER_R, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.arc(-3, 0, C.PLAYER_R - 3, Math.PI * 0.6, Math.PI * 1.4); ctx.fill();
    ctx.fillStyle = '#e0b890'; ctx.beginPath(); ctx.arc(2, 0, 7, 0, TAU); ctx.fill(); ctx.strokeStyle = '#111'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();
    if (!me) {
      ctx.globalAlpha = hidden ? 0.6 : 1;
      ctx.font = 'bold 12px Georgia'; ctx.textAlign = 'center'; ctx.fillStyle = '#000'; ctx.fillText(name, x + 1, y - 27); ctx.fillStyle = '#f3ead0'; ctx.fillText(name, x, y - 28);
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - 17, y - 25, 34, 5); ctx.fillStyle = hp > 50 ? '#6fcf5b' : hp > 25 ? '#e5b94a' : '#e0524d'; ctx.fillRect(x - 16, y - 24, 32 * clamp(hp / 100, 0, 1), 3);
      ctx.globalAlpha = 1;
    }
  }

  function drawSwing(w, now) {
    const W = WEAPONS[w.w] || WEAPONS.fists, k = (now - w.t) / 200;
    ctx.save(); ctx.translate(w.x, w.y); ctx.rotate(w.a);
    ctx.globalAlpha = (1 - k) * 0.75; ctx.strokeStyle = '#fff'; ctx.lineCap = 'round';
    if (W.arc < 50) { ctx.lineWidth = 3; line(20, 0, 20 + (W.range - 12) * clamp(k * 3, 0.3, 1), 0); }
    else { const half = (W.arc * Math.PI) / 360; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(0, 0, W.range * (0.7 + k * 0.3), -half + k * half * 0.6, half * (0.4 + k * 0.6)); ctx.stroke(); }
    ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawMutt(mu, t) {
    ctx.save(); ctx.translate(mu[1], mu[2]); ctx.rotate(mu[3]);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(2, 4, 20, 12, 0, 0, TAU); ctx.fill();
    const leg = Math.sin(t * 16 + mu[0]) * 4;
    ctx.fillStyle = '#2b2226'; ctx.beginPath(); ctx.ellipse(0, 0, 19, 11, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#3b2f33'; ctx.beginPath(); ctx.arc(17, leg * 0.3, 9, 0, TAU); ctx.fill();
    ctx.fillStyle = '#4a3a3e'; ctx.beginPath(); ctx.moveTo(20, -5); ctx.lineTo(24, -11); ctx.lineTo(15, -8); ctx.fill(); ctx.beginPath(); ctx.moveTo(20, 5); ctx.lineTo(24, 11); ctx.lineTo(15, 8); ctx.fill();
    ctx.fillStyle = '#ff3b2a'; ctx.beginPath(); ctx.arc(21, -3.5, 2, 0, TAU); ctx.arc(21, 3.5, 2, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#2b2226'; ctx.lineWidth = 4; line(-8, -9, -12 + leg, -15); line(-8, 9, -12 - leg, 15); line(-18, 0, -28, leg);
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(mu[1] - 15, mu[2] - 26, 30, 4); ctx.fillStyle = '#c33'; ctx.fillRect(mu[1] - 14, mu[2] - 25, 28 * clamp(mu[4] / 40, 0, 1), 2);
  }

  function drawTree(s) {
    const r = s.r, h = 14 + s.v * 8;
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.arc(s.x + 7, s.y + 9, r * 1.3, 0, TAU); ctx.fill();
    ctx.fillStyle = `hsl(112,38%,${h}%)`; ctx.beginPath(); ctx.arc(s.x, s.y, r * 1.32, 0, TAU); ctx.fill();
    ctx.fillStyle = `hsl(116,36%,${h + 8}%)`; ctx.beginPath(); ctx.arc(s.x - r * 0.12, s.y - r * 0.12, r * 1.02, 0, TAU); ctx.fill();
    ctx.fillStyle = `hsl(104,38%,${h + 16}%)`; ctx.beginPath(); ctx.arc(s.x - r * 0.35, s.y - r * 0.35, r * 0.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#4a3320'; ctx.beginPath(); ctx.arc(s.x, s.y, r * 0.22, 0, TAU); ctx.fill();
  }
  function drawRock(s) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.arc(s.x + 5, s.y + 6, s.r * 1.05, 0, TAU); ctx.fill();
    ctx.fillStyle = '#6d6a62'; ctx.strokeStyle = '#3a3833'; ctx.lineWidth = 2; ctx.beginPath();
    s.pts.forEach((p, i) => (i ? ctx.lineTo(s.x + p[0], s.y + p[1]) : ctx.moveTo(s.x + p[0], s.y + p[1]))); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.beginPath(); ctx.arc(s.x - s.r * 0.25, s.y - s.r * 0.25, s.r * 0.45, 0, TAU); ctx.fill();
  }

  function drawBush(b, t, now) {
    const rs = G.rustle[b.id] && now - G.rustle[b.id] < 350;
    const ox = rs ? Math.sin(t * 45 + b.id) * 3 : 0, oy = rs ? Math.cos(t * 38 + b.id) * 2 : 0;
    const mine = G.last.me.hid && inBush(G.map, G.me.x, G.me.y) === b.id;
    ctx.globalAlpha = mine ? 0.7 : 0.93;
    for (const o of b.blobs) {
      ctx.fillStyle = `hsl(${96 + o.l * 22},${42 + o.l * 10}%,${15 + o.l * 10}%)`;
      ctx.beginPath(); ctx.arc(b.x + o.x + ox, b.y + o.y + oy, o.r, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = 'rgba(150,210,90,0.22)';
    for (const o of b.blobs) { ctx.beginPath(); ctx.arc(b.x + o.x - o.r * 0.25 + ox, b.y + o.y - o.r * 0.3 + oy, o.r * 0.45, 0, TAU); ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  function drawHorn(t) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(6, 10, 70, 44, 0, 0, TAU); ctx.fill();
    ctx.rotate(-0.35);
    const g = ctx.createLinearGradient(-80, -40, 40, 50); g.addColorStop(0, '#8a6417'); g.addColorStop(0.5, '#f0cf6a'); g.addColorStop(1, '#a57a22');
    ctx.fillStyle = g; ctx.strokeStyle = '#5a3f0c'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-82, -34); ctx.bezierCurveTo(-60, -10, -10, -34, 30, -44); ctx.lineTo(30, 44); ctx.bezierCurveTo(-20, 30, -64, 6, -82, -34); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#4a3208'; ctx.beginPath(); ctx.ellipse(30, 0, 13, 44, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,245,200,0.5)'; ctx.beginPath(); ctx.ellipse(-20, -16, 38, 5, -0.25, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.fillStyle = `rgba(255,230,140,${0.25 + Math.sin(t * 3) * 0.1})`; ctx.beginPath(); ctx.arc(0, 0, 54, 0, TAU); ctx.fill();
  }

  function drawHazard(h, t) {
    const [id, type, x, y, r, st, pg] = h;
    ctx.save(); ctx.translate(x, y);
    if (type === 1) { // incendie
      if (st === 0) { ctx.setLineDash([10, 8]); ctx.strokeStyle = `rgba(255,70,30,${0.5 + Math.sin(t * 12) * 0.3})`; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,60,20,0.1)'; ctx.fill(); }
      else {
        const k = clamp(1 - pg * 0.4, 0.6, 1), g = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r);
        g.addColorStop(0, `rgba(255,210,80,${0.8 * k})`); g.addColorStop(0.6, `rgba(255,100,20,${0.6 * k})`); g.addColorStop(1, 'rgba(120,20,0,0.25)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
        for (let i = 0; i < 9; i++) { const a = i * 2.4 + id, d = r * 0.65 * ((i * 0.37 + t * 0.4) % 1), f = 14 + Math.sin(t * 9 + i) * 6; ctx.fillStyle = `rgba(255,${150 + (i % 3) * 30},40,0.7)`; ctx.beginPath(); ctx.ellipse(Math.cos(a) * d, Math.sin(a) * d - f * 0.4, f * 0.55, f, 0, 0, TAU); ctx.fill(); }
      }
    } else if (type === 2) { // gaz
      const a = st === 0 ? pg * 0.5 : 0.5 * (1 - Math.max(0, pg - 0.85) / 0.15);
      for (let i = 0; i < 7; i++) { const an = i * 0.9 + t * 0.3 + id, d = r * 0.4 * Math.sin(t * 0.6 + i); ctx.fillStyle = `rgba(130,205,60,${0.16 * a * 2})`; ctx.beginPath(); ctx.arc(Math.cos(an) * d, Math.sin(an) * d, r * (0.55 + (i % 3) * 0.1), 0, TAU); ctx.fill(); }
      ctx.strokeStyle = `rgba(170,230,90,${0.35 * a * 2})`; ctx.lineWidth = 2; ctx.setLineDash([6, 8]); ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    } else if (type === 3) { // foudre
      if (st === 0) { ctx.strokeStyle = `rgba(255,240,120,${0.4 + pg * 0.5})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, r * (1.7 - 0.7 * pg), 0, TAU); ctx.stroke(); ctx.fillStyle = `rgba(255,240,120,${0.06 + pg * 0.2})`; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); }
      else {
        ctx.fillStyle = 'rgba(255,255,230,0.55)'; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#fffbe0'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(0, -700); let yy = -700; while (yy < 0) { yy += 70; ctx.lineTo(rand(-30, 30), Math.min(0, yy)); } ctx.stroke();
      }
    } else if (type === 4) { // parachute
      if (st === 0) {
        const fall = (1 - pg) * (1 - pg) * 900, s = 0.5 + pg * 0.5;
        ctx.fillStyle = `rgba(0,0,0,${0.15 + pg * 0.2})`; ctx.beginPath(); ctx.ellipse(0, 0, 26 * s, 16 * s, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,60,40,0.5)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 40, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
        ctx.translate(0, -fall);
        ctx.fillStyle = '#e8e2d0'; ctx.beginPath(); ctx.arc(0, -36, 34, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#a02020'; ctx.lineWidth = 3; ctx.stroke();
        ctx.strokeStyle = '#777'; ctx.lineWidth = 1; line(-34, -36, -9, -4); line(34, -36, 9, -4); line(0, -70, 0, -6);
        ctx.fillStyle = '#c8a24a'; ctx.strokeStyle = '#5a3f0c'; ctx.lineWidth = 2; ctx.fillRect(-10, -6, 20, 16); ctx.strokeRect(-10, -6, 20, 16);
      } else {
        ctx.fillStyle = `rgba(255,225,120,${0.18 + Math.sin(t * 3) * 0.08})`; ctx.beginPath(); ctx.arc(0, 0, 70, 0, TAU); ctx.fill();
        ctx.fillStyle = '#b8862b'; ctx.strokeStyle = '#5a3f0c'; ctx.lineWidth = 2; ctx.fillRect(-14, -10, 28, 20); ctx.strokeRect(-14, -10, 28, 20);
      }
    }
    ctx.restore();
  }

  /* ---------- HUD ---------- */
  function drawHUD(s, m, cx, cy, others) {
    const { W, H, zoom } = G, now = performance.now();
    ctx.textBaseline = 'alphabetic';
    const shadowText = (txt, x, y, size, color, align = 'left', weight = 'bold') => {
      ctx.font = `${weight} ${size}px Georgia`; ctx.textAlign = align;
      ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillText(txt, x + 1.5, y + 1.5); ctx.fillStyle = color; ctx.fillText(txt, x, y);
    };

    // balises de largage hors écran
    for (const b of s.bc) {
      const dx = (b[1] - G.view.x) * zoom, dy = (b[2] - G.view.y) * zoom;
      if (Math.abs(dx) < W / 2 - 40 && Math.abs(dy) < H / 2 - 40) continue;
      const a = Math.atan2(dy, dx), rr = Math.min(W, H) / 2 - 46;
      ctx.save(); ctx.translate(W / 2 + Math.cos(a) * rr, H / 2 + Math.sin(a) * rr); ctx.rotate(a);
      ctx.fillStyle = `rgba(255,214,90,${0.7 + Math.sin(G.t * 6) * 0.3})`; ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -9); ctx.lineTo(-8, 9); ctx.fill(); ctx.restore();
      shadowText('🪂', W / 2 + Math.cos(a) * (rr - 26), H / 2 + Math.sin(a) * (rr - 26) + 6, 16, '#fff', 'center');
    }

    // phase / compte à rebours
    if (s.ph === 0) {
      shadowText('LES JEUX COMMENCENT DANS', W / 2, H * 0.3, 22, '#e5b94a', 'center');
      shadowText(String(Math.max(1, Math.ceil(s.cd))), W / 2, H * 0.3 + 84, 84, '#fff', 'center');
      shadowText('Cours vers la Corne d\'abondance... ou fuis dans les bois.', W / 2, H * 0.3 + 120, 15, '#d9cfb0', 'center', 'italic');
    }

    // infos haut-gauche
    shadowText(`Survivants : ${s.n} / ${s.tot}`, 16, 28, 17, '#f3ead0');
    const zt = Math.ceil(s.zt);
    if (s.z[6] === 0) shadowText(`🔥 Le mur se referme dans ${zt}s`, 16, 50, 14, '#ffbf80', 'left', 'normal');
    else if (s.z[6] === 1) shadowText(`🔥 Le mur avance ! (${zt}s)`, 16, 50, 14, '#ff7a50');
    else shadowText('🔥 Dernier cercle', 16, 50, 14, '#ff7a50');
    shadowText(`${Math.floor(s.tm / 60)}:${String(s.tm % 60).padStart(2, '0')}  ·  ${pingMs} ms`, 16, 70, 12, '#9c9378', 'left', 'normal');
    shadowText(`☠ ${m.k}`, 16, 90, 14, '#e0b0a0', 'left', 'normal');
    if (G.last.wx === 1) shadowText('⛈ Orage', 16, 110, 14, '#a8c0ff'); else if (G.last.wx === 2) shadowText('🌫 Brouillard', 16, 110, 14, '#d0d8d0');

    // annonces des Juges
    let ay = 62;
    G.anns.forEach((a, i) => {
      const age = (now - a.t) / 1000, al = clamp(Math.min(age * 4, (6 - age) * 1.5), 0, 1) * (i === 0 ? 1 : 0.75);
      ctx.globalAlpha = al; shadowText(a.text, W / 2, ay, i === 0 ? 22 : 16, '#ffe08a', 'center'); ctx.globalAlpha = 1; ay += i === 0 ? 30 : 22;
    });
    // journal
    // mini-carte (position) + journal en dessous
    const mr = Math.max(56, Math.min(W, H) * 0.1), mx = W - mr - 16, my = mr + 16, sc = mr / C.ARENA_R;
    let ly = my + mr + 26;
    G.logs.forEach(l => { const age = (now - l.t) / 1000; ctx.globalAlpha = clamp((9 - age) / 1.5, 0, 1); shadowText(l.text, W - 16, ly, 13, '#e8dcc0', 'right', 'normal'); ctx.globalAlpha = 1; ly += 20; });
    ctx.fillStyle = 'rgba(8,14,8,0.8)'; ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.clip();
    ctx.fillStyle = 'rgba(46,80,40,0.6)'; ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(220,200,130,0.5)'; ctx.beginPath(); ctx.arc(mx, my, 250 * sc, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(190,45,10,0.45)'; ctx.beginPath(); ctx.rect(mx - mr, my - mr, mr * 2, mr * 2); ctx.arc(mx + s.z[0] * sc, my + s.z[1] * sc, Math.max(0.5, s.z[2] * sc), 0, TAU); ctx.fill('evenodd');
    if (s.z[5] < s.z[2] - 2) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(mx + s.z[3] * sc, my + s.z[4] * sc, s.z[5] * sc, 0, TAU); ctx.stroke(); }
    for (const b of s.bc) { ctx.fillStyle = `rgba(255,214,90,${0.6 + Math.sin(G.t * 6) * 0.4})`; ctx.beginPath(); ctx.arc(mx + b[1] * sc, my + b[2] * sc, 4, 0, TAU); ctx.fill(); }
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(mx + G.me.x * sc, my + G.me.y * sc, 3, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(229,185,74,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.stroke();

    if (!m.al) { // spectateur / mort
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, H - 96, W, 96);
      shadowText(G.dead ? `TU ES TOMBÉ — place n°${G.dead.place}` : 'TU ES TOMBÉ', W / 2, H - 58, 26, '#e0524d', 'center');
      shadowText(`${G.dead && G.dead.killer ? 'Tué par ' + G.dead.killer + ' · ' : ''}Tu observes ${m.sp || ''} — clic ou Tab pour changer`, W / 2, H - 30, 14, '#d9cfb0', 'center', 'normal');
      return;
    }

    // invite de ramassage
    let near = null, bd = 48;
    for (const it of s.it) { const d = Math.hypot(it[2] - G.me.x, it[3] - G.me.y); if (d < bd) { bd = d; near = it; } }
    if (near && s.ph === 1) shadowText(`[E] ${itemName(near[1])}`, W / 2, H / 2 + 62, 16, '#fff2c0', 'center');
    // astuces
    G.tips.forEach((tp, i) => { const age = (now - tp.t) / 1000; ctx.globalAlpha = clamp((2.6 - age) * 2, 0, 1); shadowText(tp.text, W / 2, H / 2 - 56 - i * 22, 17, '#c8f0a0', 'center'); ctx.globalAlpha = 1; });

    // barres de vie
    const bx = 16, bw = Math.min(260, W * 0.4), by = H - 34;
    const bar = (y, h, frac, col, label) => {
      ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(bx - 2, y - 2, bw + 4, h + 4);
      ctx.fillStyle = col; ctx.fillRect(bx, y, bw * clamp(frac, 0, 1), h);
      if (label) shadowText(label, bx + 8, y + h - 4, h - 4, '#fff', 'left', 'bold');
    };
    if (m.hid) shadowText('🌿 Tu es caché', bx, by - 60, 14, '#b8f09a');
    if (m.po) shadowText('☠ Empoisonné', bx + 130, by - 60, 14, '#c58aff');
    bar(by - 44, 6, m.st / 100, m.sl ? '#a08a3a' : '#cfc15a');
    if (m.ar > 0) bar(by - 32, 8, m.ar / C.MAX_ARMOR, '#5b8fc8');
    bar(by - 18, 22, m.hp / 100, m.hp > 50 ? '#4fa63e' : m.hp > 25 ? '#d1a52f' : '#c9392f', `${Math.ceil(m.hp)} PV`);

    // arme
    const W0 = WEAPONS[m.w], wx = W / 2, wy = H - 28;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(wx - 100, wy - 24, 200, 40);
    ctx.save(); ctx.translate(wx - 70, wy - 4); ctx.scale(0.5, 0.5); if (m.w !== 'fists') drawWeapon(m.w); ctx.restore();
    shadowText(W0.name, wx - 28, wy - 4, 16, '#f3ead0');
    if (W0.ranged) shadowText(`${m.aw} flèches`, wx - 28, wy + 12, 12, m.aw ? '#d8c08a' : '#e0524d', 'left', 'normal');
    // jauge de recharge
    if (G.localCd > 0.05) { const f = clamp(G.localCd / W0.cd, 0, 1); ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(W / 2 - 20, H / 2 + 30, 40 * f, 3); }
  }

  if (qs.has('debug')) window.G = G; // outil de test
  show('menu');
})();
