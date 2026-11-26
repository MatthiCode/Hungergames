/* Code partagé client + serveur : constantes, génération de la carte, collisions, déplacement.
 * Le client s'en sert pour prédire son propre mouvement, le serveur pour faire autorité. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HG = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const C = {
    ARENA_R: 1600,
    PLAYER_R: 16,
    SPEED: 210,
    SPRINT: 1.55,
    WATER_SLOW: 0.55,
    MAX_HP: 100,
    MAX_ARMOR: 60,
    VISION: 560,
    HIDE_REVEAL: 85, // distance à laquelle on repère quelqu'un caché dans un buisson
    TICK: 30,
    STAMINA_MAX: 100,
    STAMINA_DRAIN: 32,
    STAMINA_REGEN: 18,
    MAX_PLAYERS: 8,
  };

  const COLORS = ['#e5b94a', '#e0524d', '#4aa3e5', '#7bd36b', '#c77be8', '#ef8f3a', '#4fd1c5', '#f06fb0'];

  const WEAPONS = {
    fists:    { name: 'Poings',    dmg: 8,  range: 34, cd: 0.38, arc: 80,  push: 6 },
    knife:    { name: 'Couteau',   dmg: 14, range: 42, cd: 0.28, arc: 70,  push: 4 },
    sword:    { name: 'Épée',      dmg: 26, range: 60, cd: 0.55, arc: 110, push: 10 },
    axe:      { name: 'Hache',     dmg: 40, range: 54, cd: 1.0,  arc: 120, push: 26 },
    spear:    { name: 'Lance',     dmg: 24, range: 98, cd: 0.72, arc: 34,  push: 12 },
    bow:      { name: 'Arc',       dmg: 22, cd: 0.7, ranged: true, speed: 650, life: 1.25 },
    crossbow: { name: 'Arbalète',  dmg: 38, cd: 1.4, ranged: true, speed: 880, life: 1.2 },
  };

  const ITEMS = {
    berry:   { name: 'Baies (à tes risques)' },
    bandage: { name: 'Bandage (+40 PV)' },
    armor:   { name: 'Armure (+40)' },
    quiver:  { name: 'Carquois (+8 flèches)' },
  };

  function itemName(kind) {
    if (WEAPONS[kind]) return WEAPONS[kind].name;
    return ITEMS[kind] ? ITEMS[kind].name : kind;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function angDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  /* Carte déterministe à partir d'une graine : serveur et clients obtiennent la même. */
  function genMap(seed) {
    const rnd = mulberry32(seed >>> 0);
    const R = C.ARENA_R;
    const solids = [{ x: 0, y: 0, r: 46, k: 'horn' }]; // la corne d'abondance
    const ponds = [], bushes = [], spawns = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      spawns.push({ x: Math.cos(a) * 330, y: Math.sin(a) * 330, a: a + Math.PI });
    }
    const near = (x, y, r, list, gap) => list.some(o => Math.hypot(o.x - x, o.y - y) < o.r + r + gap);
    const nearSpawn = (x, y, m) => spawns.some(s => Math.hypot(s.x - x, s.y - y) < m);
    const pt = (minR, maxR) => {
      const a = rnd() * Math.PI * 2, d = minR + Math.sqrt(rnd()) * (maxR - minR);
      return [Math.cos(a) * d, Math.sin(a) * d];
    };

    for (let i = 0, n = 0; i < 200 && n < 4; i++) {
      const [x, y] = pt(480, R - 220);
      const r = 90 + rnd() * 60;
      if (near(x, y, r, ponds, 60)) continue;
      ponds.push({ x, y, r }); n++;
    }
    for (let i = 0, n = 0; i < 1200 && n < 100; i++) {
      const [x, y] = pt(290, R - 45);
      const r = 22 + rnd() * 12;
      if (near(x, y, r, solids, 26) || near(x, y, r, ponds, 8) || nearSpawn(x, y, 80)) continue;
      solids.push({ x, y, r, k: 'tree', v: rnd() }); n++;
    }
    for (let i = 0, n = 0; i < 800 && n < 26; i++) {
      const [x, y] = pt(280, R - 45);
      const r = 20 + rnd() * 24;
      if (near(x, y, r, solids, 20) || near(x, y, r, ponds, 8) || nearSpawn(x, y, 80)) continue;
      solids.push({ x, y, r, k: 'rock', v: rnd() }); n++;
    }
    for (let c = 0; c < 28; c++) {
      const [cx, cy] = pt(c < 6 ? 200 : 330, R - 90);
      const k = 2 + Math.floor(rnd() * 3);
      for (let j = 0; j < k; j++) {
        const x = cx + (rnd() - 0.5) * 120, y = cy + (rnd() - 0.5) * 120, r = 38 + rnd() * 20;
        if (Math.hypot(x, y) > R - 60) continue;
        if (near(x, y, r * 0.7, solids, 0) || near(x, y, r * 0.5, ponds, 0) || nearSpawn(x, y, 55)) continue;
        bushes.push({ id: bushes.length, x, y, r });
      }
    }
    return { seed, solids, ponds, bushes, spawns };
  }

  function collide(p, r, map) {
    const S = map.solids;
    for (let it = 0; it < 2; it++) {
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        let dx = p.x - s.x, dy = p.y - s.y;
        const min = r + s.r;
        if (Math.abs(dx) > min || Math.abs(dy) > min) continue;
        let d = Math.hypot(dx, dy);
        if (d < min) {
          if (d < 0.001) { dx = 1; dy = 0; d = 1; }
          const k = (min - d) / d;
          p.x += dx * k; p.y += dy * k;
        }
      }
    }
    const d0 = Math.hypot(p.x, p.y), lim = C.ARENA_R - r - 2;
    if (d0 > lim) { p.x *= lim / d0; p.y *= lim / d0; }
  }

  function inBush(map, x, y) {
    const B = map.bushes;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (Math.hypot(b.x - x, b.y - y) < b.r * 0.78) return b.id;
    }
    return -1;
  }

  function inWater(map, x, y) {
    for (const p of map.ponds) if (Math.hypot(p.x - x, p.y - y) < p.r * 0.92) return true;
    return false;
  }

  /* Un pas de déplacement. p = {x,y,st,slock,spd}. Renvoie true si le joueur bouge. */
  function stepMove(p, mx, my, sprint, dt, map) {
    let len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; len = 1; }
    const moving = len > 0.05;
    let mult = p.spd;
    let sprinting = false;
    if (sprint && moving && !p.slock && p.st > 0 && p.spd > 0) {
      sprinting = true;
      p.st = Math.max(0, p.st - C.STAMINA_DRAIN * dt);
      mult *= C.SPRINT;
      if (p.st <= 0) p.slock = true;
    } else {
      p.st = Math.min(C.STAMINA_MAX, p.st + C.STAMINA_REGEN * dt);
      if (p.slock && p.st >= 25) p.slock = false;
    }
    if (inWater(map, p.x, p.y)) mult *= C.WATER_SLOW;
    if (moving && mult > 0) {
      const d = C.SPEED * mult * dt;
      p.x += mx * d; p.y += my * d;
      collide(p, C.PLAYER_R, map);
    }
    p.sprinting = sprinting;
    return moving && mult > 0;
  }

  return { C, COLORS, WEAPONS, ITEMS, itemName, mulberry32, angDiff, genMap, collide, inBush, inWater, stepMove };
});
