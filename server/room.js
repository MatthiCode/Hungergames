'use strict';
const { C, COLORS } = require('../public/shared.js');
const { Game } = require('./game.js');

/* Un salon : liste de joueurs + éventuellement une partie en cours. */
class Room {
  constructor(code, onEmpty) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.members = new Map(); // id -> {id, ws, name, color, send, sendRaw}
    this.host = null;
    this.state = 'lobby';
    this.game = null;
  }

  add(m) {
    if (this.members.size >= C.MAX_PLAYERS) return 'Le salon est plein.';
    if (this.state !== 'lobby') return 'Une partie est déjà en cours dans ce salon.';
    const used = new Set([...this.members.values()].map(x => x.color));
    m.color = COLORS.find(c => !used.has(c)) || COLORS[0];
    this.members.set(m.id, m);
    if (this.host === null) this.host = m.id;
    this.broadcastLobby();
    return null;
  }

  remove(id) {
    if (!this.members.has(id)) return;
    if (this.game) this.game.leave(id);
    this.members.delete(id);
    if (this.host === id) this.host = this.members.size ? this.members.keys().next().value : null;
    if (!this.members.size) { if (this.game) this.game.stop(); this.onEmpty(this); return; }
    this.broadcastLobby();
  }

  broadcast(obj) { for (const m of this.members.values()) m.send(obj); }

  broadcastLobby() {
    this.broadcast({
      t: 'room', code: this.code, host: this.host, state: this.state, max: C.MAX_PLAYERS,
      players: [...this.members.values()].map(m => ({ id: m.id, name: m.name, color: m.color })),
    });
  }

  start(id) {
    if (id !== this.host || this.state !== 'lobby' || !this.members.size) return;
    this.state = 'playing';
    this.game = new Game([...this.members.values()], res => {
      this.state = 'lobby'; this.game = null;
      this.broadcast({ t: 'over', ...res });
      this.broadcastLobby();
    });
    for (const m of this.members.values()) m.send({ t: 'start', seed: this.game.seed, you: m.id });
    this.game.start();
    this.broadcastLobby();
  }
}

module.exports = { Room };
