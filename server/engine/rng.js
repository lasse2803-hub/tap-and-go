/**
 * Seeded PRNG (mulberry32). The generator state lives INSIDE the object passed in
 * (e.g. the game state), so a game is fully serializable and replays identically
 * from its seed — any failing simulated game can be reproduced exactly.
 */
function seedState(seed) {
  // Spread small integer seeds over the 32-bit space.
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  return h || 1;
}

function rand(holder) {
  holder.rng = (holder.rng + 0x6d2b79f5) >>> 0;
  let t = holder.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const int = (holder, n) => Math.floor(rand(holder) * n);
const pick = (holder, arr) => arr[int(holder, arr.length)];

function shuffle(holder, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = int(holder, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { seedState, rand, int, pick, shuffle };
