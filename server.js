const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Provably-fair helpers ----
let serverSeed = crypto.randomBytes(32).toString('hex');
let nonceCounter = 0;
function hmacSHA256(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest('hex');
}
function sha256(msg) {
  return crypto.createHash('sha256').update(msg).digest('hex');
}
// Generates a float in [0,1) from HMAC(serverSeed, clientSeed:nonce)
function pfRandom(clientSeed, nonce) {
  const data = `${clientSeed}:${nonce}`;
  const hash = hmacSHA256(serverSeed, data);
  // Use first 13 hex chars (~52 bits) -> integer then / 2^52
  const slice = hash.substring(0, 13);
  const int = parseInt(slice, 16);
  return int / Math.pow(2, 52);
}

app.get('/api/seed', (req, res) => {
  res.json({ serverSeedHash: sha256(serverSeed) });
});

app.post('/api/seed/rotate', (req, res) => {
  const old = serverSeed;
  serverSeed = crypto.randomBytes(32).toString('hex');
  nonceCounter = 0;
  res.json({ revealed: old, newServerSeedHash: sha256(serverSeed) });
});

// ---- Wallet (demo, in-memory) ----
const users = {}; // {sessionId: {balance: number}}
function getSession(req) {
  let id = req.headers['x-session-id'];
  if (!id) id = 'guest';
  if (!users[id]) users[id] = { balance: 10000 };
  return id;
}
function adjustBalance(id, delta) {
  users[id].balance += delta;
  return users[id].balance;
}
app.get('/api/balance', (req, res) => {
  const id = getSession(req);
  res.json({ session: id, balance: users[id].balance });
});

// ---- Games ----

// Dice: target in (1..99), over=false means roll < target wins
app.post('/api/dice', (req, res) => {
  const id = getSession(req);
  const { bet=0, target=50, over=false, clientSeed='client', nonce } = req.body || {};
  if (bet <= 0 || users[id].balance < bet) return res.status(400).json({ error: 'Insufficient or invalid bet' });
  const n = (typeof nonce === 'number') ? nonce : (nonceCounter++);
  const r = pfRandom(clientSeed, n); // 0..1
  const roll = Math.floor(r * 10000) / 100; // 0.00..99.99
  let win = false, payout = 0;
  if (over) {
    win = roll > target;
    const edge = 0.01;
    const prob = (100 - target - 0.01) / 100;
    const fairMult = (1 - edge) / prob;
    payout = win ? Math.floor(bet * fairMult * 100) / 100 : 0;
  } else {
    win = roll < target;
    const edge = 0.01;
    const prob = (target) / 100;
    const fairMult = (1 - edge) / prob;
    payout = win ? Math.floor(bet * fairMult * 100) / 100 : 0;
  }
  adjustBalance(id, win ? (payout - bet) : (-bet));
  res.json({ roll, win, payout, balance: users[id].balance, nonce: n });
});

// Coinflip: 50/50
app.post('/api/coinflip', (req, res) => {
  const id = getSession(req);
  const { bet=0, pick='heads', clientSeed='client', nonce } = req.body || {};
  if (bet <= 0 || users[id].balance < bet) return res.status(400).json({ error: 'Insufficient or invalid bet' });
  const n = (typeof nonce === 'number') ? nonce : (nonceCounter++);
  const r = pfRandom(clientSeed, n);
  const result = (r < 0.5) ? 'heads' : 'tails';
  const win = (result === pick);
  const payout = win ? Math.floor(bet * 1.98 * 100) / 100 : 0;
  adjustBalance(id, win ? (payout - bet) : (-bet));
  res.json({ result, win, payout, balance: users[id].balance, nonce: n });
});

// Hi-Lo: guess if next card higher or lower than current
const ranks = [2,3,4,5,6,7,8,9,10,11,12,13,14]; // 11=J,12=Q,13=K,14=A
function drawCard(clientSeed, nonce) {
  const r = pfRandom(clientSeed, nonce);
  const rank = ranks[Math.floor(r * ranks.length)];
  const suit = ['♠','♥','♦','♣'][Math.floor(pfRandom(clientSeed, nonce+1) * 4)];
  return { rank, suit };
}
app.post('/api/hilo/start', (req,res)=>{
  const { clientSeed='client' } = req.body || {};
  const baseNonce = nonceCounter; nonceCounter += 10;
  const current = drawCard(clientSeed, baseNonce);
  res.json({ current, nonceBase: baseNonce });
});
app.post('/api/hilo/guess', (req,res)=>{
  const id = getSession(req);
  const { bet=0, guess='higher', clientSeed='client', nonceBase } = req.body || {};
  if (bet <= 0 || users[id].balance < bet) return res.status(400).json({ error: 'Insufficient or invalid bet' });
  const current = drawCard(clientSeed, nonceBase);
  const next = drawCard(clientSeed, nonceBase+2);
  const win = (guess==='higher') ? (next.rank>current.rank) : (next.rank<current.rank);
  const eq = next.rank===current.rank;
  const payout = win ? Math.floor(bet * 1.92 * 100)/100 : 0;
  adjustBalance(id, win ? (payout - bet) : (-bet));
  res.json({ current, next, win: win && !eq, tie: eq, payout, balance: users[id].balance });
});

// Blackjack: single-deck, dealer stands on 17, no splits/doubles in demo
function bjScore(hand) {
  let total = 0, aces = 0;
  for (const r of hand) {
    if (r >= 11 && r <= 13) total += 10;
    else if (r === 14) { total += 11; aces++; }
    else total += r;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function drawRank(clientSeed, nonce) {
  const r = pfRandom(clientSeed, nonce);
  return ranks[Math.floor(r * ranks.length)];
}
app.post('/api/blackjack/start', (req,res)=>{
  const { clientSeed='client' } = req.body || {};
  const base = nonceCounter; nonceCounter += 10;
  const player = [drawRank(clientSeed, base), drawRank(clientSeed, base+1)];
  const dealer = [drawRank(clientSeed, base+2), drawRank(clientSeed, base+3)];
  res.json({ player, dealer, nonceBase: base });
});
app.post('/api/blackjack/play', (req,res)=>{
  const id = getSession(req);
  const { bet=0, clientSeed='client', nonceBase, actions=[] } = req.body || {};
  if (bet <= 0 || users[id].balance < bet) return res.status(400).json({ error: 'Insufficient or invalid bet' });
  let player = [drawRank(clientSeed, nonceBase), drawRank(clientSeed, nonceBase+1)];
  let dealer = [drawRank(clientSeed, nonceBase+2), drawRank(clientSeed, nonceBase+3)];
  let n = nonceBase+4;
  for (const act of actions) {
    if (act==='hit') player.push(drawRank(clientSeed, n++));
    if (act==='stand') break;
  }
  // dealer plays
  while (bjScore(dealer) < 17) dealer.push(drawRank(clientSeed, n++));
  const ps = bjScore(player), ds = bjScore(dealer);
  let outcome = 'lose', payout = 0;
  if (ps>21) outcome='bust';
  else if (ds>21 || ps>ds) { outcome='win'; payout = Math.floor(bet*1.98*100)/100; }
  else if (ps===ds) { outcome='push'; payout = bet; }
  adjustBalance(id, payout - bet);
  res.json({ player, dealer, ps, ds, outcome, payout, balance: users[id].balance });
});

// Mines: 5x5 grid with 3 mines. Server stores layout per session (ephemeral).
const minesBoards = {}; // sessionId -> { bombs:Set<string> }
function newMinesBoard() {
  const bombs = new Set();
  while (bombs.size < 3) {
    const x = Math.floor(Math.random()*5), y = Math.floor(Math.random()*5);
    bombs.add(`${x},${y}`);
  }
  return bombs;
}
app.post('/api/mines/new', (req,res)=>{
  const id = getSession(req);
  minesBoards[id] = { bombs: newMinesBoard(), revealed: new Set() };
  res.json({ ok: true });
});
app.post('/api/mines/click', (req,res)=>{
  const id = getSession(req);
  const { bet=0, x, y } = req.body || {};
  if (bet <= 0 || users[id].balance < bet) return res.status(400).json({ error: 'Insufficient or invalid bet' });
  const b = minesBoards[id] || (minesBoards[id]={ bombs: newMinesBoard(), revealed: new Set() });
  const key = `${x},${y}`;
  if (b.bombs.has(key)) {
    adjustBalance(id, -bet);
    return res.json({ boom: true, balance: users[id].balance });
  }
  b.revealed.add(key);
  const safeCount = b.revealed.size;
  const payout = Math.floor(bet * (1 + safeCount * 0.2) * 100) / 100;
  res.json({ boom: false, payout, safeCount, balance: users[id].balance });
});

// Limbo: pick target multiplier, win if r < 1/target
app.post('/api/limbo', (req,res)=>{
  const id = getSession(req);
  const { bet=0, target=2.0, clientSeed='client', nonce } = req.body || {};
  if (bet <= 0 || users[id].balance < bet) return res.status(400).json({ error: 'Insufficient or invalid bet' });
  const n = (typeof nonce === 'number') ? nonce : (nonceCounter++);
  const r = pfRandom(clientSeed, n);
  const win = r < (1/target)*0.99;
  const payout = win ? Math.floor(bet * target * 0.99 * 100)/100 : 0;
  adjustBalance(id, win ? (payout - bet) : (-bet));
  res.json({ win, roll:r, payout, balance: users[id].balance, nonce:n });
});

// Roulette (very simplified): bet type 'red'/'black'/'even'/'odd'/'number'
const redNumbers = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
app.post('/api/roulette', (req,res)=>{
  const id = getSession(req);
  const { bet=0, type='red', number=null, clientSeed='client', nonce } = req.body || {};
  if (bet <= 0 || users[id].balance < bet) return res.status(400).json({ error: 'Insufficient or invalid bet' });
  const n = (typeof nonce === 'number') ? nonce : (nonceCounter++);
  const r = Math.floor(pfRandom(clientSeed, n) * 37); // 0..36
  let win=false, mult=0;
  if (type==='number' && number!==null) { win = (r===number); mult=36; }
  else if (type==='red') { win = redNumbers.has(r); mult=2; }
  else if (type==='black') { win = (r!==0 && !redNumbers.has(r)); mult=2; }
  else if (type==='even') { win = (r!==0 && r%2===0); mult=2; }
  else if (type==='odd') { win = (r%2===1); mult=2; }
  const payout = win ? Math.floor(bet * mult * 0.98 * 100)/100 : 0;
  adjustBalance(id, win ? (payout - bet) : (-bet));
  res.json({ result: r, win, payout, balance: users[id].balance, nonce:n });
});

// Plinko: 12 rows, result index 0..12 -> multipliers table
const plinkoMults = [0.2,0.3,0.5,0.8,1,1.2,3,1.2,1,0.8,0.5,0.3,0.2];
app.post('/api/plinko', (req,res)=>{
  const id = getSession(req);
  const { bet=0, clientSeed='client', nonce } = req.body || {};
  if (bet <= 0 || users[id].balance < bet) return res.status(400).json({ error: 'Insufficient or invalid bet' });
  const n = (typeof nonce === 'number') ? nonce : (nonceCounter++);
  // Simulate path by summing coin flips
  let pos = 0;
  for (let i=0;i<12;i++) pos += (pfRandom(clientSeed, n+i) < 0.5 ? 0 : 1);
  const index = pos;
  const mult = plinkoMults[index] || 0;
  const payout = Math.floor(bet * mult * 100)/100;
  adjustBalance(id, payout - bet);
  res.json({ index, mult, payout, balance: users[id].balance, nonce:n });
});

// Keno: draw 20 of 1..40
app.post('/api/keno', (req,res)=>{
  const id = getSession(req);
  const { bet=0, picks=[], clientSeed='client', nonce } = req.body || {};
  if (bet <= 0 || users[id].balance < bet) return res.status(400).json({ error: 'Insufficient or invalid bet' });
  if (!Array.isArray(picks) || picks.length<1 || picks.length>10) return res.status(400).json({ error: 'Pick 1..10 numbers' });
  const n = (typeof nonce === 'number') ? nonce : (nonceCounter++);
  const pool = Array.from({length:40}, (_,i)=>i+1);
  // Fisher-Yates using pfRandom
  for (let i=pool.length-1;i>0;i--) {
    const j = Math.floor(pfRandom(clientSeed, n+i) * (i+1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const draw = pool.slice(0,20);
  const set = new Set(draw);
  const hits = picks.filter(x=>set.has(x)).length;
  // simple paytable
  const pay = {1:[0,1.9],2:[0,1,3.5],3:[0,0.5,2,9],4:[0,0.5,2,7,28],5:[0,0,1,5,12,50],6:[0,0,0.5,3,10,30,75],7:[0,0,0.5,2,7,20,50,120],8:[0,0,0.5,2,5,15,40,90,200],9:[0,0,0.5,1,3,10,25,60,120,300],10:[0,0,0.5,1,2,7,20,50,100,200,500]};
  const table = pay[picks.length];
  const mult = table[hits] || 0;
  const payout = Math.floor(bet * mult * 100)/100;
  adjustBalance(id, payout - bet);
  res.json({ draw, hits, payout, balance: users[id].balance, nonce:n });
});

// Wheel: 20 segments with a few big multipliers
app.post('/api/wheel', (req,res)=>{
  const id = getSession(req);
  const { bet=0, clientSeed='client', nonce } = req.body || {};
  if (bet <= 0 || users[id].balance < bet) return res.status(400).json({ error: 'Insufficient or invalid bet' });
  const segMults = [1,1,1,2,2,3,5,10,1,1,1,2,2,3,5,1,1,2,3,20];
  const n = (typeof nonce === 'number') ? nonce : (nonceCounter++);
  const idx = Math.floor(pfRandom(clientSeed, n) * segMults.length);
  const mult = segMults[idx];
  const payout = Math.floor(bet * mult * 0.99 * 100)/100;
  adjustBalance(id, payout - bet);
  res.json({ index: idx, mult, payout, balance: users[id].balance, nonce:n });
});

// Crash via Socket.IO: server runs rounds; multiplier grows until crash point.
let crashState = { inRound: false, startTime: 0, crashAt: 1.0 };
function scheduleCrashRound() {
  if (crashState.inRound) return;
  crashState.inRound = true;
  crashState.startTime = Date.now();
  // Generate crash point with Pareto-ish distribution
  const u = Math.random();
  const crashAt = Math.max(1.0, 1 / (1 - u) * 0.5); // heavy tail
  crashState.crashAt = crashAt;
  const tick = () => {
    if (!crashState.inRound) return;
    const elapsed = (Date.now() - crashState.startTime) / 1000;
    // Multiplier grows ~ 1 + t*1.2
    const current = 1 + elapsed * 1.2;
    io.emit('crash:tick', { current });
    if (current >= crashState.crashAt) {
      io.emit('crash:end', { at: crashState.crashAt });
      crashState.inRound = false;
      setTimeout(scheduleCrashRound, 3000);
    } else {
      setTimeout(tick, 200);
    }
  };
  tick();
}
io.on('connection', (socket)=>{
  socket.emit('crash:status', crashState);
  if (!crashState.inRound) setTimeout(scheduleCrashRound, 1000);
  socket.on('crash:cashout', ({ bet, at })=>{
    // No per-user tracking in demo; frontend handles showing result.
    socket.emit('crash:cashout:ack', { payout: Math.floor(bet * at * 0.99 * 100)/100 });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log(`HexaBets demo running on http://localhost:${PORT}`));
