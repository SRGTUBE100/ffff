# HexaBets — Node.js Demo (Coins Only)

This is a **fully-local demo** of a Stake-style site using **virtual coins only** (no real money). It includes basic working versions of these games:
- Dice
- Coinflip
- Hi‑Lo
- Blackjack
- Mines (5x5, 3 mines)
- Crash (round-based via Socket.IO)
- Plinko (simple board)
- Keno (pick up to 10)
- Roulette (single-number, red/black, even/odd)
- Limbo (target multiplier)
- Wheel (simple segments)

> ⚠️ For education/testing only. If you plan to deploy publicly, you are responsible for age checks, licensing, KYC/AML, geo‑blocking, and local laws.

## Quick Start

```bash
npm install
npm start
# open http://localhost:3000
```

The frontend is served from `/public` using React via CDN and Babel Standalone, so there is **no build step**.
