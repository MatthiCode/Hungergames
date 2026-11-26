'use strict';
/* Simulation autoritaire d'une partie. 30 ticks/s. */
const HG = require('../public/shared.js');
const { C, WEAPONS, genMap, collide, inBush, stepMove, angDiff } = HG;

const R = C.ARENA_R;
// Le mur de flammes se referme par étapes
const ZONE = [
  { delay: 55, dur: 30, r: 1150 },
  { delay: 45, dur: 30, r: 800 },
  { delay: 40, dur: 25, r: 520 },
  { delay: 35, dur: 25, r: 300 },
  { delay: 30, dur: 25, r: 150 },
  { delay: 20, dur: 20, r: 45 },
];
const ZONE_DPS = [2.5, 4, 6, 8, 11, 15, 20];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[(Math.random() * a.length) | 0];
const r1 = v => Math.round(v);
const r2 = v => Math.round(v * 100) / 100;
const r10 = v => Math.round(v * 10) / 10;
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
function weighted(table) {
  let t = table.reduce((s, e) => s + e[1], 0), x = Math.random() * t;
  for (const [v, w] of table) { x -= w; if (x <= 0) return v; }
  return table[0][0];
}

const DEATH_TEXT = {
  zone: 'a été consumé par le mur de flammes',
  fire: 'a péri dans les flammes',
  gas: 'a respiré le gaz toxique',
  bolt: 'a été foudroyé',
  mutt: 'a été dévoré par une muttation',
  poison: 'a mangé les mauvaises baies',
  quit: "a quitté l'arène",
};

class Game {
  /* members : [{id, name, color, send(obj), sendRaw(str)}] */
  constructor(members, onEnd) {
    this.onEnd = onEnd;
    this.seed = (Math.random() * 2147483647) | 0;
    this.map = genMap(this.seed);
    this.players = new Map();
    this.items = new Map();
    this.projs = [];
    this.mutts = [];
    this.hazards = [];
    this.nid = 0;
    this.time = 0;
    this.phase = 'countdown';
    this.cdT = 5;
    this.overT = 0;
    this.weather = { type: 0, t: 0, bolt: 0 };
    this.nextEvent = process.env.HG_FAST ? 4 : 22;
    this.lastEvent = '';
    this.fx = [];
    this.timer = null;
    this.winner = null;
    this.startCount = members.length;
    this.zone = { cx: 0, cy: 0, r: R, tcx: 0, tcy: 0, tr: R, mode: 0, t: 0, st: 0, dur: 1, idx: 0, from: null, warned: false };
    this.planZone();

    const n = members.length, off = (Math.random() * 8) | 0;
    members.forEach((m, i) => {
      const sp = this.map.spawns[(off + Math.round((i * 8) / n)) % 8];
      this.players.set(m.id, {
        id: m.id, name: m.name, color: m.color, send: m.send, sendRaw: m.sendRaw, connected: true,
        x: sp.x, y: sp.y, aim: sp.a, hp: C.MAX_HP, armor: 0, st: C.STAMINA_MAX, slock: false, spd: 1,
        w: 'fists', arrows: 0, cd: 0, alive: true, kills: 0, place: 0, atk: false, lastSeq: 0, budget: 0.25,
        revealT: 0, poison: 0, hurtT: 0, slowT: 0, moving: false, sprinting: false, spec: null,
      });
    });
    this.lootCornucopia();
    this.lootOutskirts();
  }

  start() {
    this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { console.error('Erreur de tick :', e); }
    }, 1000 / C.TICK);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /* ---------- utilitaires ---------- */
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) if (p.connected) p.sendRaw(s);
  }
  announce(text) { this.broadcast({ t: 'msg', k: 'ann', text }); }
  log(text) { this.broadcast({ t: 'msg', k: 'log', text }); }
  aliveCount() { let n = 0; for (const p of this.players.values()) if (p.alive) n++; return n; }
  alivePlayers() { return [...this.players.values()].filter(p => p.alive); }
  isHidden(p) { return this.time >= p.revealT && inBush(this.map, p.x, p.y) >= 0; }
  visionFor() { const w = this.weather.type; return C.VISION * (w === 2 ? 0.5 : w === 1 ? 0.8 : 1); }
  statusSpd(p) { if (this.phase !== 'playing') return 0; return p.slowT > 0 ? 0.7 : 1; }

  freePoint(minR, maxR, r = 18) {
    for (let i = 0; i < 80; i++) {
      const a = Math.random() * Math.PI * 2, d = rnd(minR, maxR);
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      if (!this.map.solids.some(s => Math.hypot(s.x - x, s.y - y) < s.r + r)) return { x, y };
    }
    return { x: 0, y: maxR };
  }
  zonePoint(margin = 80, r = 20) {
    const z = this.zone;
    for (let i = 0; i < 80; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * Math.max(40, z.r - margin);
      const x = z.cx + Math.cos(a) * d, y = z.cy + Math.sin(a) * d;
      if (Math.hypot(x, y) > R - 40) continue;
      if (!this.map.solids.some(s => Math.hypot(s.x - x, s.y - y) < s.r + r)) return { x, y };
    }
    return { x: z.cx, y: z.cy };
  }

  addItem(kind, x, y) {
    const it = { id: ++this.nid, kind, x, y };
    if (kind === 'berry') it.poison = Math.random() < 0.35;
    this.items.set(it.id, it);
    return it;
  }

  lootCornucopia() {
    const list = shuffle(['sword', 'sword', 'axe', 'spear', 'spear', 'bow', 'bow', 'crossbow', 'knife', 'knife', 'knife', 'knife',
      'armor', 'armor', 'bandage', 'bandage', 'bandage', 'quiver', 'quiver', 'quiver', 'berry', 'berry']);
    const n = list.length;
    list.forEach((k, i) => {
      const a = (i / n) * Math.PI * 2 + rnd(-0.1, 0.1), d = [95, 150, 205][i % 3] + rnd(-12, 12);
      this.addItem(k, Math.cos(a) * d, Math.sin(a) * d);
    });
  }
  lootOutskirts() {
    const table = [['knife', 4], ['bandage', 5], ['berry', 6], ['quiver', 3], ['sword', 1], ['spear', 1], ['armor', 1], ['bow', 1]];
    for (let i = 0; i < 30; i++) {
      const p = this.freePoint(300, R - 70);
      this.addItem(weighted(table), p.x, p.y);
    }
  }

  /* ---------- le mur de flammes ---------- */
  planZone() {
    const z = this.zone, S = ZONE[z.idx];
    z.mode = 0; z.t = S.delay; z.warned = false; z.tr = S.r;
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * Math.max(0, z.r - S.r) * 0.85;
    z.tcx = z.cx + Math.cos(a) * d; z.tcy = z.cy + Math.sin(a) * d;
  }
  updateZone(dt) {
    const z = this.zone;
    if (z.mode === 2) return;
    if (z.mode === 0) {
      z.t -= dt;
      if (z.t <= 10 && !z.warned) { z.warned = true; this.announce('🔥 Le mur de flammes se referme dans 10 secondes !'); }
      if (z.t <= 0) { z.mode = 1; z.st = 0; z.dur = ZONE[z.idx].dur; z.from = { cx: z.cx, cy: z.cy, r: z.r }; this.fx.push(['horn', 0, 0, 0, 0, 0, 1]); }
    } else {
      z.st += dt;
      const k = Math.min(1, z.st / z.dur);
      z.cx = z.from.cx + (z.tcx - z.from.cx) * k;
      z.cy = z.from.cy + (z.tcy - z.from.cy) * k;
      z.r = z.from.r + (z.tr - z.from.r) * k;
      if (k >= 1) { z.idx++; if (z.idx >= ZONE.length) z.mode = 2; else this.planZone(); }
    }
  }

  /* ---------- entrées joueurs ---------- */
  input(id, m) {
    const p = this.players.get(id);
    if (!p || !p.alive || !m) return;
    if (typeof m.aim === 'number' && isFinite(m.aim)) p.aim = m.aim;
    p.atk = !!m.atk;
    let dt = Math.max(0, Math.min(+m.dt || 0, 0.05));
    dt = Math.min(dt, p.budget); p.budget -= dt; // anti-speedhack : on ne crédite que le temps réel écoulé
    p.spd = this.statusSpd(p);
    p.moving = stepMove(p, +m.mx || 0, +m.my || 0, !!m.sprint, dt, this.map);
    p.lastSeq = m.seq | 0;
  }

  pickup(id) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase !== 'playing') return;
    let best = null, bd = 48;
    for (const it of this.items.values()) {
      const d = Math.hypot(it.x - p.x, it.y - p.y);
      if (d < bd) { bd = d; best = it; }
    }
    if (!best) return;
    const k = best.kind;
    if (WEAPONS[k]) {
      if (p.w !== 'fists') { const a = Math.random() * 6.28; this.addItem(p.w, p.x + Math.cos(a) * 26, p.y + Math.sin(a) * 26); }
      p.w = k; p.cd = Math.max(p.cd, 0.2);
      if (WEAPONS[k].ranged && p.arrows < 6) p.arrows = 6;
    } else if (k === 'berry') {
      if (best.poison) {
        p.poison = Math.min(8, p.poison + 5);
        p.send({ t: 'msg', k: 'tip', text: '☠ Ces baies étaient empoisonnées !' });
      } else { p.hp = Math.min(C.MAX_HP, p.hp + 20); p.send({ t: 'msg', k: 'tip', text: '🍇 Délicieux ! +20 PV' }); }
    } else if (k === 'bandage') p.hp = Math.min(C.MAX_HP, p.hp + 40);
    else if (k === 'armor') p.armor = Math.min(C.MAX_ARMOR, p.armor + 40);
    else if (k === 'quiver') p.arrows = Math.min(40, p.arrows + 8);
    this.items.delete(best.id);
    this.fx.push(['pick', r1(p.x), r1(p.y)]);
  }

  spectate(id) {
    const p = this.players.get(id);
    if (!p || p.alive) return;
    const alive = this.alivePlayers();
    if (!alive.length) return;
    const i = alive.findIndex(q => q.id === p.spec);
    p.spec = alive[(i + 1) % alive.length].id;
  }

  leave(id) {
    const p = this.players.get(id);
    if (!p || !p.connected) return;
    p.connected = false;
    if (p.alive && this.phase !== 'over') {
      if (this.phase === 'countdown') { p.alive = false; p.place = this.aliveCount() + 1; this.log(`${p.name} a quitté l'arène`); }
      else this.kill(p, null, 'quit');
    }
    if (![...this.players.values()].some(q => q.connected)) this.stop();
  }

  /* ---------- combat ---------- */
  hurt(p, amt, src, cause, pierce) {
    if (!p.alive || this.phase !== 'playing' || amt <= 0) return 0;
    if (!pierce && p.armor > 0) { const ab = Math.min(p.armor, amt * 0.7); p.armor -= ab; amt -= ab; }
    p.hp -= amt; p.hurtT = 0.25;
    if (src) p.revealT = Math.max(p.revealT, this.time + 1.0);
    if (p.hp <= 0) this.kill(p, src, cause);
    return amt;
  }

  kill(p, killer, cause) {
    if (!p.alive) return;
    p.alive = false; p.hp = 0; p.atk = false;
    p.place = this.aliveCount() + 1;
    if (killer && killer !== p) killer.kills++;
    if (p.w !== 'fists') this.addItem(p.w, p.x + 14, p.y);
    if (p.arrows >= 4) this.addItem('quiver', p.x - 14, p.y);
    this.fx.push(['cannon', r1(p.x), r1(p.y), 0, 0, 0, 1]);
    this.fx.push(['death', r1(p.x), r1(p.y), 0, 0, 0]);
    this.log(killer && killer !== p ? `☠ ${p.name} a été tué par ${killer.name}` : `☠ ${p.name} ${DEATH_TEXT[cause] || 'est mort'}`);
    this.announce(`💥 Un coup de canon retentit... ${p.name} est tombé.`);
    p.spec = killer && killer.alive ? killer.id : null;
    p.send({ t: 'dead', place: p.place, killer: killer && killer !== p ? killer.name : null, cause });
  }

  inArc(p, q, W, rad) {
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    if (d > W.range + rad) return false;
    if (d < rad + 10) return true;
    return Math.abs(angDiff(Math.atan2(dy, dx), p.aim)) <= (W.arc * Math.PI) / 360 + Math.asin(Math.min(1, rad / d));
  }

  attack(p) {
    const W = WEAPONS[p.w];
    const amb = this.isHidden(p) ? 1.5 : 1;
    p.cd = W.cd;
    if (W.ranged) {
      if (p.arrows <= 0) { p.cd = 0.35; return; }
      p.arrows--;
      this.projs.push({
        id: ++this.nid, x: p.x + Math.cos(p.aim) * 22, y: p.y + Math.sin(p.aim) * 22,
        vx: Math.cos(p.aim) * W.speed, vy: Math.sin(p.aim) * W.speed, owner: p.id, dmg: W.dmg * amb, life: W.life, a: p.aim, w: p.w,
      });
      this.fx.push(['shot', r1(p.x), r1(p.y), r2(p.aim), p.id, p.w]);
      if (amb > 1) p.send({ t: 'msg', k: 'tip', text: '🌿 Embuscade ! Dégâts x1.5' });
    } else {
      this.fx.push(['swing', r1(p.x), r1(p.y), r2(p.aim), p.id, p.w]);
      let ambushed = false;
      for (const q of this.players.values()) {
        if (q === p || !q.alive || !this.inArc(p, q, W, C.PLAYER_R)) continue;
        const dealt = this.hurt(q, W.dmg * amb, p, 'melee');
        this.fx.push(['hit', r1(q.x), r1(q.y), r1(dealt), 0, 'p']);
        const a = Math.atan2(q.y - p.y, q.x - p.x);
        q.x += Math.cos(a) * W.push; q.y += Math.sin(a) * W.push; collide(q, C.PLAYER_R, this.map);
        ambushed = ambushed || amb > 1;
      }
      for (const m of this.mutts) {
        if (m.hp <= 0 || !this.inArc(p, m, W, 14)) continue;
        m.hp -= W.dmg * amb;
        this.fx.push(['hit', r1(m.x), r1(m.y), r1(W.dmg * amb), 0, 'm']);
        const a = Math.atan2(m.y - p.y, m.x - p.x);
        m.x += Math.cos(a) * W.push; m.y += Math.sin(a) * W.push;
      }
      if (ambushed) p.send({ t: 'msg', k: 'tip', text: '🌿 Embuscade ! Dégâts x1.5' });
    }
    p.revealT = Math.max(p.revealT, this.time + 1.5); // attaquer te trahit
  }

  /* ---------- boucle ---------- */
  tick() {
    const dt = 1 / C.TICK;
    for (const p of this.players.values()) p.budget = Math.min(0.25, p.budget + dt);

    if (this.phase === 'countdown') {
      this.cdT -= dt;
      if (this.cdT <= 0) {
        this.phase = 'playing';
        this.announce('⚔ QUE LES JEUX COMMENCENT !');
        this.fx.push(['gong', 0, 0, 0, 0, 0, 1]);
      }
    } else if (this.phase === 'playing') {
      this.time += dt;
      this.updatePlayers(dt);
      this.updateZone(dt);
      this.updateEvents(dt);
      this.updateHazards(dt);
      this.updateMutts(dt);
      this.updateProjs(dt);
      this.checkEnd();
    } else if (this.phase === 'over') {
      this.overT -= dt;
      if (this.overT <= 0) { this.stop(); this.onEnd && this.onEnd(this.result()); return; }
    }
    this.sendSnapshots();
    this.fx.length = 0;
  }

  updatePlayers(dt) {
    const z = this.zone, dps = ZONE_DPS[Math.min(z.idx, ZONE_DPS.length - 1)];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      p.cd = Math.max(0, p.cd - dt);
      p.hurtT = Math.max(0, p.hurtT - dt);
      p.slowT = Math.max(0, p.slowT - dt);
      if (p.poison > 0) { p.poison -= dt; this.hurt(p, 5 * dt, null, 'poison', true); }
      if (!p.alive) continue;
      if (Math.hypot(p.x - z.cx, p.y - z.cy) > z.r) this.hurt(p, dps * dt, null, 'zone', true);
      if (!p.alive) continue;
      if (p.atk && p.cd <= 0) this.attack(p);
    }
  }

  /* ---------- évènements des Juges ---------- */
  updateEvents(dt) {
    const w = this.weather;
    if (w.type) {
      w.t -= dt;
      if (w.type === 1) {
        w.bolt -= dt;
        if (w.bolt <= 0) {
          w.bolt = rnd(0.7, 1.3);
          const al = this.alivePlayers();
          let pos;
          if (al.length && Math.random() < 0.5) { const t = pick(al); const a = Math.random() * 6.28, d = rnd(0, 110); pos = { x: t.x + Math.cos(a) * d, y: t.y + Math.sin(a) * d }; }
          else pos = this.zonePoint(40, 10);
          this.hazards.push({ id: ++this.nid, type: 'bolt', x: pos.x, y: pos.y, r: 75, age: 0, warn: 1.2, struck: false });
        }
      }
      if (w.t <= 0) { w.type = 0; this.announce('☀ Le ciel se dégage.'); }
    }
    this.nextEvent -= dt;
    if (this.nextEvent > 0) return;
    this.nextEvent = process.env.HG_FAST ? rnd(5, 8) : rnd(20, 32);
    const table = [['supply', 3], ['mutts', 2], ['fire', 2], ['storm', 2], ['gas', 2], ['fog', 2], ['berries', 1]]
      .filter(([k]) => k !== this.lastEvent && !(this.weather.type && (k === 'storm' || k === 'fog')));
    this.lastEvent = weighted(table);
    this.runEvent(this.lastEvent);
  }

  runEvent(kind) {
    const al = this.alivePlayers();
    if (kind === 'supply') {
      const p = this.zonePoint(150, 40);
      this.hazards.push({ id: ++this.nid, type: 'drop', x: p.x, y: p.y, r: 60, age: 0, fall: 9, life: 40, landed: false });
      this.announce('🪂 Un parachute de sponsor tombe dans l\'arène ! (voir la carte)');
    } else if (kind === 'mutts') {
      const n = Math.min(5, Math.max(3, al.length + 1)), base = Math.random() * 6.28;
      for (let i = 0; i < n; i++) {
        const a = base + rnd(-0.5, 0.5);
        this.mutts.push({ id: ++this.nid, x: Math.cos(a) * (R - 70), y: Math.sin(a) * (R - 70), a: 0, hp: 35, cd: 1.2, life: 45, wt: 0, wa: Math.random() * 6.28 });
      }
      this.announce('🐺 Les Juges lâchent des muttations !');
      this.fx.push(['howl', 0, 0, 0, 0, 0, 1]);
    } else if (kind === 'fire') {
      for (let i = 0; i < 3; i++) {
        let pos;
        if (al.length) { const t = pick(al), a = Math.random() * 6.28, d = rnd(120, 320); pos = { x: t.x + Math.cos(a) * d, y: t.y + Math.sin(a) * d }; }
        else pos = this.zonePoint(100);
        const d0 = Math.hypot(pos.x, pos.y); if (d0 > R - 140) { pos.x *= (R - 140) / d0; pos.y *= (R - 140) / d0; }
        this.hazards.push({ id: ++this.nid, type: 'fire', x: pos.x, y: pos.y, r: 130, age: 0, warn: 2.5, life: 15 });
      }
      this.announce('🔥 Les Juges déclenchent des incendies !');
    } else if (kind === 'storm') {
      this.weather = { type: 1, t: 24, bolt: 1 };
      this.announce('⛈ Un orage éclate ! Méfie-toi de la foudre.');
    } else if (kind === 'fog') {
      this.weather = { type: 2, t: 28, bolt: 0 };
      this.announce('🌫 Un brouillard épais tombe... on ne voit plus rien.');
    } else if (kind === 'gas') {
      for (let i = 0; i < 2; i++) {
        const p = this.zonePoint(150), a = Math.random() * 6.28, v = rnd(22, 34);
        this.hazards.push({ id: ++this.nid, type: 'gas', x: p.x, y: p.y, r: 200, age: 0, warn: 2, life: 24, vx: Math.cos(a) * v, vy: Math.sin(a) * v });
      }
      this.announce('☣ Un nuage de gaz toxique dérive dans l\'arène !');
    } else if (kind === 'berries') {
      for (let i = 0; i < 14; i++) { const p = this.zonePoint(60); this.addItem('berry', p.x, p.y); }
      this.announce('🍇 Des baies mûrissent partout... certaines sont mortelles.');
    }
  }

  updateHazards(dt) {
    const keep = [];
    for (const h of this.hazards) {
      h.age += dt;
      let alive = true;
      if (h.type === 'fire') {
        if (h.age >= h.warn) this.areaDamage(h, 16 * dt, 'fire', false);
        alive = h.age < h.warn + h.life;
      } else if (h.type === 'gas') {
        h.x += h.vx * dt; h.y += h.vy * dt;
        const d = Math.hypot(h.x, h.y);
        if (d > R - 100) { const nx = h.x / d, ny = h.y / d, dot = h.vx * nx + h.vy * ny; if (dot > 0) { h.vx -= 2 * dot * nx; h.vy -= 2 * dot * ny; } }
        if (h.age >= h.warn) this.areaDamage(h, 7 * dt, 'gas', true);
        alive = h.age < h.warn + h.life;
      } else if (h.type === 'bolt') {
        if (!h.struck && h.age >= h.warn) {
          h.struck = true;
          this.fx.push(['bolt', r1(h.x), r1(h.y), 0, 0, 0, 1]);
          this.areaDamage(h, 45, 'bolt', false, true);
        }
        alive = h.age < h.warn + 0.4;
      } else if (h.type === 'drop') {
        if (!h.landed && h.age >= h.fall) {
          h.landed = true;
          this.fx.push(['land', r1(h.x), r1(h.y), 0, 0, 0, 1]);
          const loot = [pick(['axe', 'crossbow', 'spear', 'sword']), 'armor', 'bandage', 'quiver', Math.random() < 0.5 ? 'bandage' : 'sword'];
          loot.forEach((k, i) => { const a = (i / loot.length) * 6.28 + 0.4; this.addItem(k, h.x + Math.cos(a) * 38, h.y + Math.sin(a) * 38); });
          this.announce('📦 Le parachute a touché le sol !');
        }
        alive = h.age < h.fall + h.life;
      }
      if (alive) keep.push(h);
    }
    this.hazards = keep;
  }

  areaDamage(h, amt, cause, pierce, once) {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (Math.hypot(p.x - h.x, p.y - h.y) < h.r + 8) {
        if (cause === 'gas') p.slowT = 0.3;
        this.hurt(p, amt, null, cause, pierce);
        if (once && p.alive) this.fx.push(['hit', r1(p.x), r1(p.y), r1(amt), 0, 'p']);
      }
    }
    for (const m of this.mutts) if (Math.hypot(m.x - h.x, m.y - h.y) < h.r) m.hp -= amt * (once ? 1 : 1.2);
  }

  /* ---------- muttations ---------- */
  updateMutts(dt) {
    const al = this.alivePlayers();
    const out = [];
    for (const m of this.mutts) {
      m.life -= dt; m.cd -= dt; m.wt -= dt;
      if (m.hp <= 0) { this.fx.push(['hit', r1(m.x), r1(m.y), 0, 0, 'k']); continue; }
      if (m.life <= 0) continue;
      let tgt = null, bd = Infinity;
      for (const p of al) {
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (this.isHidden(p) && d > 110) continue;
        if (d < bd) { bd = d; tgt = p; }
      }
      let a;
      if (tgt) a = Math.atan2(tgt.y - m.y, tgt.x - m.x);
      else { if (m.wt <= 0) { m.wt = rnd(1, 2.5); m.wa = Math.random() * 6.28; } a = m.wa; }
      m.a = a;
      const sp = tgt ? 165 : 70;
      m.x += Math.cos(a) * sp * dt; m.y += Math.sin(a) * sp * dt;
      collide(m, 14, this.map);
      if (tgt && bd < 34 && m.cd <= 0) { m.cd = 1.0; this.hurt(tgt, 8, null, 'mutt'); this.fx.push(['hit', r1(tgt.x), r1(tgt.y), 8, 0, 'p']); }
      out.push(m);
    }
    this.mutts = out;
  }

  /* ---------- projectiles ---------- */
  updateProjs(dt) {
    const out = [];
    outer: for (const pr of this.projs) {
      pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.life -= dt;
      if (pr.life <= 0 || Math.hypot(pr.x, pr.y) > R) continue;
      for (const s of this.map.solids) {
        if (Math.hypot(s.x - pr.x, s.y - pr.y) < s.r) { this.fx.push(['thud', r1(pr.x), r1(pr.y)]); continue outer; }
      }
      for (const p of this.players.values()) {
        if (!p.alive || p.id === pr.owner) continue;
        if (Math.hypot(p.x - pr.x, p.y - pr.y) < C.PLAYER_R + 5) {
          const dealt = this.hurt(p, pr.dmg, this.players.get(pr.owner), 'arrow');
          this.fx.push(['hit', r1(p.x), r1(p.y), r1(dealt), 0, 'p']);
          continue outer;
        }
      }
      for (const m of this.mutts) {
        if (m.hp > 0 && Math.hypot(m.x - pr.x, m.y - pr.y) < 20) {
          m.hp -= pr.dmg; this.fx.push(['hit', r1(m.x), r1(m.y), r1(pr.dmg), 0, 'm']); continue outer;
        }
      }
      out.push(pr);
    }
    this.projs = out;
  }

  /* ---------- fin de partie ---------- */
  checkEnd() {
    const n = this.aliveCount();
    if (this.startCount >= 2 ? n <= 1 : n === 0) {
      this.phase = 'over'; this.overT = 4.5;
      this.winner = this.alivePlayers()[0] || null;
      if (this.winner) { this.winner.place = 1; this.announce(`👑 ${this.winner.name} remporte les Jeux de la Faim !`); }
      else this.announce('Personne ne survit à l\'arène...');
    }
  }
  result() {
    const ranking = [...this.players.values()].sort((a, b) => (a.place || 99) - (b.place || 99))
      .map(p => ({ id: p.id, name: p.name, color: p.color, place: p.place, kills: p.kills }));
    return { winner: this.winner ? { id: this.winner.id, name: this.winner.name } : null, ranking };
  }

  /* ---------- envoi des états (chaque joueur ne reçoit que ce qu'il peut voir) ---------- */
  viewOf(p) {
    if (p.alive) return p;
    let t = this.players.get(p.spec);
    if (!t || !t.alive) { t = this.alivePlayers()[0] || p; p.spec = t.id; }
    return t;
  }

  sendSnapshots() {
    const vis = this.visionFor();
    const beacons = [];
    for (const h of this.hazards) if (h.type === 'drop') beacons.push([h.id, r1(h.x), r1(h.y), h.landed ? 1 : 0, r2(Math.min(1, h.age / h.fall))]);
    const z = this.zone;
    const zarr = [r1(z.cx), r1(z.cy), r1(z.r), r1(z.tcx), r1(z.tcy), r1(z.tr), z.mode];
    const zt = z.mode === 0 ? z.t : z.mode === 1 ? z.dur - z.st : 0;
    const alive = this.aliveCount();

    for (const pl of this.players.values()) {
      if (!pl.connected) continue;
      const v = this.viewOf(pl);
      const near = (o, extra = 0) => Math.abs(o.x - v.x) < vis + extra && Math.abs(o.y - v.y) < vis + extra && Math.hypot(o.x - v.x, o.y - v.y) < vis + extra;
      const ps = [], ru = [];
      for (const q of this.players.values()) {
        if (q === v || !q.alive) continue;
        const d = Math.hypot(q.x - v.x, q.y - v.y);
        if (d > vis) continue;
        let fl = 0;
        if (this.isHidden(q)) {
          if (d > C.HIDE_REVEAL) {
            if (q.moving && d < vis * 0.8) { const b = inBush(this.map, q.x, q.y); if (b >= 0 && !ru.includes(b)) ru.push(b); }
            continue;
          }
          fl |= 1;
        }
        if (q.hurtT > 0) fl |= 2;
        if (q.sprinting) fl |= 8;
        ps.push([q.id, r1(q.x), r1(q.y), r2(q.aim), r1(q.hp), q.w, fl]);
      }
      const it = [];
      for (const i of this.items.values()) if (near(i, 30)) it.push([i.id, i.kind, r1(i.x), r1(i.y)]);
      const pr = [];
      for (const p of this.projs) if (near(p, 60)) pr.push([p.id, r1(p.x), r1(p.y), r2(p.a), p.w]);
      const mu = [];
      for (const m of this.mutts) if (near(m, 40)) mu.push([m.id, r1(m.x), r1(m.y), r2(m.a), r1(m.hp)]);
      const hz = [];
      for (const h of this.hazards) {
        if (!near(h, h.r + 30)) continue;
        let state, prog;
        if (h.type === 'bolt') { state = h.struck ? 1 : 0; prog = Math.min(1, h.age / h.warn); }
        else if (h.type === 'drop') { state = h.landed ? 1 : 0; prog = Math.min(1, h.age / h.fall); }
        else { state = h.age < h.warn ? 0 : 1; prog = h.age < h.warn ? h.age / h.warn : (h.age - h.warn) / h.life; }
        hz.push([h.id, { fire: 1, gas: 2, bolt: 3, drop: 4 }[h.type], r1(h.x), r1(h.y), h.r, state, r2(prog)]);
      }
      const fx = [];
      for (const f of this.fx) {
        if (f[6] === 1 || Math.hypot(f[1] - v.x, f[2] - v.y) < vis + 200) fx.push(f);
      }
      const snap = {
        t: 's', ph: this.phase === 'countdown' ? 0 : this.phase === 'playing' ? 1 : 2, cd: r2(Math.max(0, this.cdT)), tm: r1(this.time),
        me: {
          x: r10(v.x), y: r10(v.y), hp: r1(v.hp), ar: r1(v.armor), st: r10(v.st), sl: v.slock, w: v.w, aw: v.arrows, cd: r2(v.cd),
          spd: this.statusSpd(v), ack: v.lastSeq, hid: this.isHidden(v), k: v.kills, po: v.poison > 0, al: pl.alive,
          sp: pl.alive ? null : v.name, aim: r2(v.aim),
        },
        n: alive, tot: this.startCount, p: ps, it, pr, mu, hz, bc: beacons, z: zarr, zt: r1(zt), wx: this.weather.type, vis: r1(vis), ru, fx,
      };
      pl.sendRaw(JSON.stringify(snap));
    }
  }
}

module.exports = { Game };
