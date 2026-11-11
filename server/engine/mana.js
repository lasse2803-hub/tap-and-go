/**
 * Mana costs and payment.
 *
 * parseCost('{2}{R}{G/P}', x) → { generic, colored: { W,U,B,R,G,C }, phyrexian: ['G'], hasX }
 * solvePayment(cost, sources, life) → { tap: [sourceIds], life } or null
 *
 * Sources are { id, options: ['G','W',…] } — each taps for exactly one mana of one of
 * its options. The solver is exact (backtracking), so "can I cast this?" is never
 * answered wrongly; the pool sizes involved are tiny.
 */
const COLORS = ['W', 'U', 'B', 'R', 'G'];

function parseCost(str, x = 0) {
  const cost = { generic: 0, colored: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, phyrexian: [], hasX: false };
  for (const sym of (str || '').match(/\{[^}]+\}/g) || []) {
    const s = sym.slice(1, -1);
    if (/^\d+$/.test(s)) cost.generic += parseInt(s, 10);
    else if (s === 'X') { cost.hasX = true; cost.generic += x; }
    else if (COLORS.includes(s) || s === 'C') cost.colored[s] += 1;
    else if (/^[WUBRG]\/P$/.test(s)) cost.phyrexian.push(s[0]);
    else throw new Error(`Unsupported mana symbol ${sym} in ${str}`);
  }
  return cost;
}

function totalMana(cost) {
  return cost.generic + Object.values(cost.colored).reduce((a, b) => a + b, 0) + cost.phyrexian.length;
}

/**
 * Find sources to tap (and life to pay for Phyrexian symbols) for `cost`.
 * Prefers paying Phyrexian with mana; only pays life while staying above 2 life.
 */
function solvePayment(cost, sources, life = 20) {
  const reqs = [];
  for (const c of [...COLORS, 'C']) for (let i = 0; i < cost.colored[c]; i++) reqs.push({ color: c, phy: false });
  for (const c of cost.phyrexian) reqs.push({ color: c, phy: true });
  // Scarce colors first: fewer usable sources → decide earlier.
  const usable = (color) => sources.filter(s => s.options.includes(color)).length;
  reqs.sort((a, b) => (a.phy - b.phy) || (usable(a.color) - usable(b.color)));
  // Least flexible sources first, so flexible ones stay free for later needs.
  const ordered = sources.slice().sort((a, b) => a.options.length - b.options.length);

  const used = new Set();
  let lifePaid = 0;

  const dfs = (i) => {
    if (i === reqs.length) {
      const free = ordered.filter(s => !used.has(s.id));
      return free.length >= cost.generic;
    }
    const r = reqs[i];
    for (const s of ordered) {
      if (used.has(s.id) || !s.options.includes(r.color)) continue;
      used.add(s.id);
      if (dfs(i + 1)) return true;
      used.delete(s.id);
    }
    if (r.phy && life - lifePaid - 2 > 2) {
      lifePaid += 2;
      if (dfs(i + 1)) return true;
      lifePaid -= 2;
    }
    return false;
  };

  if (!dfs(0)) return null;
  const tap = [...used];
  const free = ordered.filter(s => !used.has(s.id));
  for (let k = 0; k < cost.generic; k++) tap.push(free[k].id);
  return { tap, life: lifePaid };
}

module.exports = { parseCost, solvePayment, totalMana, COLORS };
