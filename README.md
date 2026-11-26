# 🏹 Hunger Games — L'Arène

Jeu multijoueur en ligne, vu du dessus, inspiré de Hunger Games. Tu joues dans ton navigateur,
ton pote sur un autre PC : vous êtes lâchés dans l'arène, **le dernier survivant gagne**.

- 🏛 **Corne d'abondance** au centre : armes, armures, soins… et tous les tributs qui courent dessus au coup de gong
- 🌿 **Buissons** : entre dedans, tu disparais. Attaquer depuis un buisson = **embuscade (dégâts ×1,5)**
- 🎲 **Évènements aléatoires des Juges** toutes les ~20-30 s
- 🔥 **Mur de flammes** qui se referme et pousse tout le monde vers le centre
- 👁 **Brouillard de guerre** : tu ne vois que dans un rayon autour de toi
- 💥 **Coup de canon** à chaque mort, comme dans les livres
- De 1 à 8 joueurs par arène (à deux, c'est un duel)

## Lancer le jeu

Il faut [Node.js](https://nodejs.org) 18 ou plus.

```bash
npm install
npm start
```

Le serveur s'affiche avec ses adresses :

```
🏹 Hunger Games — serveur lancé sur le port 3000
   Toi (ce PC)   : http://localhost:3000
   Même réseau   : http://192.168.1.23:3000
```

Ouvre l'adresse, mets ton nom, clique **Créer une arène** : tu obtiens un **code à 4 lettres**
(et un lien d'invitation). Ton pote ouvre la même adresse et tape le code (ou ouvre le lien).
L'hôte clique sur **Lancer les Jeux**.

> Seul, tu peux lancer « Explorer l'arène seul » pour tester la carte et les évènements.

## Jouer avec un pote sur un autre PC

Le serveur doit être joignable par ton pote. Trois façons, de la plus simple à la plus durable :

### 1. Même Wi-Fi / même maison
Ton pote ouvre `http://<IP affichée par le serveur>:3000`. Si ça ne marche pas, autorise Node.js
dans le pare-feu Windows (« réseaux privés »).

### 2. À distance, sans rien configurer : un tunnel
Lance le jeu (`npm start`), puis dans un autre terminal :

```bash
# Option A — Cloudflare (gratuit, sans compte)
cloudflared tunnel --url http://localhost:3000

# Option B — ngrok (compte gratuit requis)
ngrok http 3000
```

Envoie l'adresse `https://…` affichée à ton pote : c'est tout. (Les WebSockets passent sans souci.)
Installer cloudflared : `winget install Cloudflare.cloudflared` (Windows) ou `brew install cloudflared` (Mac).

### 3. Hébergé en permanence (plus besoin que ton PC reste allumé)
Déploie ce dépôt sur un hébergeur Node gratuit ([Render](https://render.com), Railway, Fly.io…) :

| Réglage | Valeur |
|---|---|
| Build command | `npm install` |
| Start command | `npm start` |
| Port | variable d'environnement `PORT` (déjà prise en compte) |

Vous ouvrez tous les deux l'URL fournie. (Sur l'offre gratuite de Render, le serveur se met en veille
après un moment d'inactivité : le premier chargement peut prendre ~30 s.)

## Commandes

| Action | Touche |
|---|---|
| Se déplacer | **Z Q S D** (ou WASD / flèches) |
| Viser | Souris |
| Attaquer | Clic gauche |
| Sprinter | **Shift** (consomme l'endurance) |
| Ramasser / utiliser | **E** |
| Changer de joueur observé (si tu es mort) | Clic ou **Tab** |
| Couper le son | **M** |

## Armes et objets

| Arme | Dégâts | Particularité |
|---|---|---|
| Poings | 8 | toujours là |
| Couteau | 14 | très rapide |
| Épée | 26 | bon équilibre, large arc |
| Hache | 40 | lente, repousse fort |
| Lance | 24 | longue portée |
| Arc | 22 | tir à distance, a besoin de flèches |
| Arbalète | 38 | tir puissant et rapide, mais lent à recharger |

**Objets** : 🩹 bandage (+40 PV) · 🛡 armure (absorbe 70 % des dégâts jusqu'à épuisement) ·
🏹 carquois (+8 flèches) · 🍇 baies (+20 PV… **ou poison**, 1 chance sur 3 : à tes risques !)

## Les évènements des Juges

| Évènement | Effet |
|---|---|
| 🪂 **Parachute de sponsor** | Une caisse tombe quelque part (indiquée sur la mini-carte et par une flèche dorée) : bonne arme, armure, soins. Tout le monde y court… |
| 🐺 **Muttations** | Des loups mutants lâchés depuis le bord de l'arène. Ils te traquent (sauf si tu es caché dans un buisson !). |
| 🔥 **Incendies** | Des zones de feu apparaissent près des joueurs (avertissement de ~2,5 s). |
| ⛈ **Orage** | La foudre tombe (cercle jaune qui se resserre = fuis !). Visibilité réduite. |
| ☣ **Gaz toxique** | Des nuages verts dérivent dans l'arène : dégâts et ralentissement. |
| 🌫 **Brouillard épais** | Ta vision est divisée par deux. Le moment idéal pour une embuscade. |
| 🍇 **Pluie de baies** | Des baies apparaissent partout… certaines sont mortelles. |

Et en continu : le **mur de flammes** se referme par étapes sur un cercle de plus en plus petit
(le prochain cercle est dessiné en pointillés blancs sur la mini-carte et dans l'arène).

## Astuces

- Les **mares** ralentissent.
- Un buisson te cache **sauf** si quelqu'un passe tout près (< 85 px) ou si tu attaques / es touché.
  Un buisson qui frémit trahit quelqu'un qui bouge à l'intérieur.
- Les **flèches** traversent les buissons : un joueur caché peut être touché.
- Quand quelqu'un meurt, il laisse son arme au sol.

## Pour les curieux

- `server/` : serveur Node (HTTP + WebSocket via `ws`). Le serveur est **autoritaire** : il simule tout
  à 30 ticks/s et n'envoie à chaque joueur que ce qu'il peut voir (un joueur caché n'est tout simplement
  pas transmis → impossible de tricher avec un client modifié).
- `public/shared.js` : carte (générée depuis une graine commune), collisions, déplacement — partagé client/serveur
  pour la **prédiction côté client** (le jeu reste fluide même avec du ping).
- `public/client.js` : rendu Canvas 2D, interpolation, sons synthétisés (WebAudio), HUD.
- Tout se règle dans `public/shared.js` (armes, vitesses, vision) et `server/game.js` (zone, évènements, loot).
