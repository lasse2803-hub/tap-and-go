/*
 * rules-core.js — pure, side-effect-free Magic rules helpers.
 *
 * Etape 1 of the refactor: these functions were extracted verbatim from
 * client/public/index.html so they can live in one testable place instead of
 * being tangled into the 16k-line UI file. They have no dependency on React,
 * the DOM, or game state — pure (input) -> (output).
 *
 * Dual environment:
 *  - In the browser this loads as a classic <script> BEFORE the Babel block and
 *    exposes each function as a global (via Object.assign(window, api)) so the
 *    existing unqualified call sites (parseSpellEffects(...), etc.) keep working.
 *  - In Node it exports the same api via module.exports, so the test suite can
 *    require() it directly.
 *
 * Behavior is pinned by test/rules-core.characterization.test.js. Do not change
 * logic here without updating those tests in the same commit.
 */
(function (root) {
  'use strict';

  const parseManaCost = (manaCostStr) => {
    if (!manaCostStr) return { generic: 0 };
    const result = { generic: 0 };
    const matches = manaCostStr.match(/\{([^}]+)\}/g);
    if (!matches) return result;
    for (const m of matches) {
      const val = m.slice(1, -1); // strip { }
      if (/^\d+$/.test(val)) {
        result.generic += parseInt(val, 10);
      } else if (val === 'X') {
        // X costs — ignore for validation, player chooses
      } else if (['W', 'U', 'B', 'R', 'G', 'C'].includes(val)) {
        result[val] = (result[val] || 0) + 1;
      } else if (val.includes('/')) {
        // Hybrid mana like {W/U} — store as hybrid
        if (!result._hybrid) result._hybrid = [];
        result._hybrid.push(val.split('/'));
      }
    }
    return result;
  };

  const canPayManaCost = (pool, cost) => {
    const available = { ...pool };
    // Pay colored costs first
    for (const color of ['W', 'U', 'B', 'R', 'G', 'C']) {
      const needed = cost[color] || 0;
      if (available[color] < needed) return false;
      available[color] -= needed;
    }
    // Pay hybrid costs
    if (cost._hybrid) {
      for (const options of cost._hybrid) {
        const canPay = options.some(c => (available[c] || 0) > 0);
        if (!canPay) {
          // Try generic
          const totalAvailable = Object.values(available).reduce((s, v) => s + v, 0);
          if (totalAvailable < 1) return false;
          // Deduct from largest pool
          const maxColor = Object.entries(available).sort((a, b) => b[1] - a[1])[0];
          if (maxColor) available[maxColor[0]]--;
        } else {
          // Pay with first available option
          for (const c of options) {
            if ((available[c] || 0) > 0) { available[c]--; break; }
          }
        }
      }
    }
    // Pay generic cost with remaining mana
    const totalRemaining = Object.values(available).reduce((s, v) => s + v, 0);
    return totalRemaining >= (cost.generic || 0);
  };

  const deductManaCost = (pool, cost) => {
    const result = { ...pool };
    // Deduct colored
    for (const color of ['W', 'U', 'B', 'R', 'G', 'C']) {
      result[color] -= (cost[color] || 0);
    }
    // Deduct hybrid
    if (cost._hybrid) {
      for (const options of cost._hybrid) {
        for (const c of options) {
          if ((result[c] || 0) > 0) { result[c]--; break; }
        }
      }
    }
    // Deduct generic from largest pools first
    let generic = cost.generic || 0;
    while (generic > 0) {
      const maxEntry = Object.entries(result).filter(([,v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
      if (!maxEntry) break;
      result[maxEntry[0]]--;
      generic--;
    }
    return result;
  };

  const parseSpellEffects = (card) => {
    const oracle = card.oracle_text || '';
    // For adventure cards, check adventure face
    const faces = card.card_faces || [];
    const texts = [oracle, ...faces.map(f => f.oracle_text || '')].filter(Boolean);
    const allText = texts.join('\n').toLowerCase();
    const effects = [];

    // === TARGETED EFFECTS (require clicking a target) ===

    // Destroy target creature/permanent (longer patterns first to avoid partial matches)
    if (/destroy target (creature or planeswalker|nonland permanent|permanent|creature|artifact|enchantment)/.test(allText)) {
      const match = allText.match(/destroy target (creature or planeswalker|nonland permanent|permanent|creature|artifact|enchantment)/);
      effects.push({ type: 'destroy', targetType: match[1], description: `Destroy target ${match[1]}` });
    }

    // Exile target (longer patterns first)
    if (/exile target (creature or planeswalker|nonland permanent|permanent|creature|artifact|enchantment)/.test(allText) ||
        /exile (target|it).*with (converted )?mana (cost|value)/.test(allText)) {
      const match = allText.match(/exile target (creature or planeswalker|nonland permanent|permanent|creature|artifact|enchantment|\w+[\w ]*?)(?:\.|,| with)/);
      effects.push({ type: 'exile', targetType: match?.[1] || 'permanent', description: `Exile target ${match?.[1] || 'permanent'}` });
    }

    // Deal damage to any target / target creature / target player
    const dmgMatch = allText.match(/deals? (\d+|x) damage to (any target|target (creature or planeswalker|player or planeswalker|creature or player|creature|player|opponent))/);
    if (dmgMatch) {
      const amount = dmgMatch[1] === 'x' ? 0 : parseInt(dmgMatch[1]);
      const targetDesc = dmgMatch[2];
      effects.push({ type: 'damage', amount, targetDesc, description: `Deal ${dmgMatch[1]} damage to ${targetDesc}` });
    }

    // Return target to hand (bounce)
    if (/return target (creature|nonland permanent|permanent|artifact|enchantment)[\w ']*to its owner's hand/.test(allText)) {
      const match = allText.match(/return target (creature|nonland permanent|permanent|artifact|enchantment)/);
      effects.push({ type: 'bounce', targetType: match[1], description: `Return target ${match[1]} to hand` });
    }

    // Target player/opponent discards
    if (/target (player|opponent) (reveals|discards|loses)/.test(allText)) {
      effects.push({ type: 'discard', description: 'Target opponent discards' });
    }

    // Give target creature +X/+X or counters
    const boostMatch = allText.match(/target creature gets? ([+-]\d+\/[+-]\d+)/);
    if (boostMatch) {
      effects.push({ type: 'boost', amount: boostMatch[1], description: `Target creature gets ${boostMatch[1]}` });
    }
    if (/put.*\+1\/\+1 counter.*on target/.test(allText)) {
      effects.push({ type: 'counter_add', counterType: '+1/+1', description: 'Put +1/+1 counter on target' });
    }

    // Fight (target creature fights another)
    if (/target creature.*fights? (another target|target)/.test(allText) || /fights? target creature/.test(allText)) {
      effects.push({ type: 'fight', description: 'Fight target creature' });
    }

    // === NON-TARGETED / SELF EFFECTS ===

    // Scry / Surveil — parse BEFORE draw so effects array order matches "surveil X, then draw"
    // (applyNonTargetedEffects uses array index to detect scry-before-draw ordering)
    const scryMatch = allText.match(/scry (\d+)/);
    if (scryMatch) {
      const scryCount = parseInt(scryMatch[1]) || 1;
      effects.push({ type: 'scry', count: scryCount, mode: 'scry', description: `Scry ${scryCount}` });
    }
    const surveilMatch = allText.match(/surveil (\d+)/);
    if (surveilMatch && !scryMatch) {
      const surveilCount = parseInt(surveilMatch[1]) || 1;
      effects.push({ type: 'scry', count: surveilCount, mode: 'surveil', description: `Surveil ${surveilCount}` });
    }
    // Draw cards
    const drawMatch = allText.match(/draw (\w+|\d+) cards?/);
    if (drawMatch) {
      const numWords = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
      const num = numWords[drawMatch[1]] || parseInt(drawMatch[1]) || 1;
      effects.push({ type: 'draw', amount: num, description: `Draw ${num} card${num > 1 ? 's' : ''}` });
    }
    // "You may put a land card from your hand onto the battlefield" (Growth Spiral, Explore)
    if (/you may put a land card from your hand onto the battlefield/.test(allText)) {
      effects.push({ type: 'extra_land_drop', description: 'You may put a land onto the battlefield' });
    }

    // "Look at the top X cards" + "put N into your hand/onto the battlefield" (Memory Deluge, Dig Through Time, Collected Company, etc.)
    const lookTopMatch = allText.match(/look at the top (\d+|x|seven|six|five|four|three|two) cards? of your library/);
    if (lookTopMatch) {
      const numWords = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
      let lookCount = numWords[lookTopMatch[1]] || parseInt(lookTopMatch[1]);
      if (isNaN(lookCount) || lookTopMatch[1] === 'x') lookCount = -1; // variable X → prompt
      // Check if cards go to battlefield or hand
      const toBattlefieldMatch = allText.match(/put (?:up to )?(\d+|one|two|three).*?onto the battlefield/);
      const putMatch = allText.match(/put (\d+|one|two|three) of them into your hand/);
      const hw = { one: 1, two: 2, three: 3 };
      if (toBattlefieldMatch) {
        const toField = hw[toBattlefieldMatch[1]] || parseInt(toBattlefieldMatch[1]) || 1;
        // Collected Company filter: "creature cards with mana value 3 or less"
        const creatureMVMatch = allText.match(/creature cards? with (?:mana value|converted mana cost) (\d+) or less/);
        const selectFilter = creatureMVMatch ? { type: 'creature', maxMV: parseInt(creatureMVMatch[1]) } : null;
        effects.push({ type: 'look_top_battlefield', count: lookCount, toField, selectFilter, description: `Look at top ${lookCount === -1 ? 'X' : lookCount}, put ${toField} onto battlefield` });
      } else {
        let toHand = 1;
        if (putMatch) {
          toHand = hw[putMatch[1]] || parseInt(putMatch[1]) || 1;
        }
        effects.push({ type: 'look_top', count: lookCount, toHand, description: `Look at top ${lookCount === -1 ? 'X' : lookCount}, put ${toHand} into hand` });
      }
    }

    // Counter target spell (special — targets stack, not battlefield)
    // Matches: "counter target spell", "counter target noncreature spell", "counter target instant or sorcery spell"
    if (/counter target [\w\s]*spell/.test(allText)) {
      const counterDesc = (allText.match(/counter target ([\w\s]*spell)/)?.[0] || 'counter target spell');
      effects.push({ type: 'counter_spell', description: counterDesc.charAt(0).toUpperCase() + counterDesc.slice(1) });
    }

    // Gain life
    const lifeMatch = allText.match(/gain (\d+) life/);
    if (lifeMatch) {
      effects.push({ type: 'gain_life', amount: parseInt(lifeMatch[1]), description: `Gain ${lifeMatch[1]} life` });
    }

    // You lose X life (e.g. Thoughtseize)
    const loseLifeMatch = allText.match(/you lose (\d+) life/);
    if (loseLifeMatch) {
      effects.push({ type: 'lose_life', amount: parseInt(loseLifeMatch[1]), description: `You lose ${loseLifeMatch[1]} life` });
    }

    // Look at / reveal opponent's hand (e.g. Gitaxian Probe — peek only, no discard)
    // Skip if 'discard' effect already covers this (e.g. Thoughtseize, Duress — they peek AND discard)
    if ((/target (player|opponent) reveals (their|his or her) hand/.test(allText) ||
        /look at target (player|opponent)'?s? hand/.test(allText)) &&
        !effects.some(e => e.type === 'discard')) {
      effects.push({ type: 'peek_hand', description: 'Look at opponent\'s hand' });
    }

    // === BOARD WIPES / MASS EFFECTS ===

    // Destroy all creatures
    if (/destroy all creatures/.test(allText) && !/destroy all creatures with/.test(allText)) {
      effects.push({ type: 'board_wipe', subtype: 'destroy_all', description: 'Destroy all creatures' });
    }
    // Destroy all creatures with power X or greater (Elspeth, Sun's Champion -3)
    const destroyPowerMatch = allText.match(/destroy all creatures with power (\d+) or greater/);
    if (destroyPowerMatch) {
      effects.push({ type: 'board_wipe', subtype: 'destroy_power_gte', threshold: parseInt(destroyPowerMatch[1]), description: `Destroy all creatures with power ${destroyPowerMatch[1]}+` });
    }
    // Destroy all creatures with toughness X or greater
    const destroyToughMatch = allText.match(/destroy all creatures with toughness (\d+) or greater/);
    if (destroyToughMatch) {
      effects.push({ type: 'board_wipe', subtype: 'destroy_toughness_gte', threshold: parseInt(destroyToughMatch[1]), description: `Destroy all creatures with toughness ${destroyToughMatch[1]}+` });
    }
    // Destroy all creatures with mana value X or less/greater
    const destroyMVMatch = allText.match(/destroy all creatures with (mana value|converted mana cost) (\d+) or (less|greater)/);
    if (destroyMVMatch) {
      effects.push({ type: 'board_wipe', subtype: destroyMVMatch[3] === 'less' ? 'destroy_mv_lte' : 'destroy_mv_gte', threshold: parseInt(destroyMVMatch[2]), description: `Destroy creatures with MV ${destroyMVMatch[2]} or ${destroyMVMatch[3]}` });
    }
    // Destroy all nonland permanents
    if (/destroy all nonland permanents/.test(allText)) {
      effects.push({ type: 'board_wipe', subtype: 'destroy_all_nonland', description: 'Destroy all nonland permanents' });
    }
    // All creatures get -X/-X
    const massMinusMatch = allText.match(/all creatures get (-\d+\/-\d+)/);
    if (massMinusMatch) {
      effects.push({ type: 'board_wipe', subtype: 'minus', amount: massMinusMatch[1], description: `All creatures get ${massMinusMatch[1]}` });
    }
    // Exile all creatures/permanents (but not Farewell "choose one or more" cards)
    if (/exile all (creatures|nonland permanents|permanents)/.test(allText) && !/exile all.*with/.test(allText) && !/choose one or more/i.test(allText)) {
      effects.push({ type: 'board_wipe', subtype: 'exile_all', description: 'Exile all creatures' });
    }
    // Exile each permanent with power X or greater
    const exilePowerMatch = allText.match(/exile (?:all|each) (?:creature|permanent)s? with power (\d+) or greater/);
    if (exilePowerMatch) {
      effects.push({ type: 'board_wipe', subtype: 'exile_power_gte', threshold: parseInt(exilePowerMatch[1]), description: `Exile all with power ${exilePowerMatch[1]}+` });
    }
    // Exile each permanent with mana value/CMC X or less (Ugin -X style)
    const exileMVLessMatch = allText.match(/exile (?:all|each) (?:permanent|nonland permanent|creature)s?.*(?:mana value|converted mana cost) (\d+) or less/);
    if (exileMVLessMatch) {
      effects.push({ type: 'board_wipe', subtype: 'exile_mv_lte', threshold: parseInt(exileMVLessMatch[1]), description: `Exile permanents with MV ${exileMVLessMatch[1]} or less` });
    }
    // Ugin-style: "exile each permanent with mana value X or less" — variable X, prompt needed
    if (/exile each permanent.*mana value.*or less/.test(allText) && !exileMVLessMatch) {
      const isColorRestricted = /color/.test(allText);
      effects.push({ type: 'board_wipe', subtype: 'exile_mv_lte_prompt', colorOnly: isColorRestricted, description: `Exile ${isColorRestricted ? 'colored ' : ''}permanents with MV ≤ X (choose X)` });
    }
    // Shadow's Verdict style: "exile all creatures and planeswalkers with mana value X or less from the battlefield and from all graveyards"
    const shadowsVerdictMatch = allText.match(/exile all creatures and planeswalkers with (?:mana value|converted mana cost) (\d+) or less.*(?:from the battlefield and from all graveyards|from all graveyards)/);
    if (shadowsVerdictMatch) {
      effects.push({ type: 'shadows_verdict', threshold: parseInt(shadowsVerdictMatch[1]), description: `Exile creatures & PWs with MV ≤ ${shadowsVerdictMatch[1]} from battlefield + graveyards` });
    }

    // Farewell-style: "choose one or more" with exile categories (artifacts, creatures, enchantments, graveyards)
    if (/choose one or more/i.test(allText) && /exile all/i.test(allText)) {
      const categories = [];
      if (/exile all artifacts/i.test(allText)) categories.push('artifacts');
      if (/exile all creatures/i.test(allText)) categories.push('creatures');
      if (/exile all enchantments/i.test(allText)) categories.push('enchantments');
      if (/exile all cards from all graveyards/i.test(allText)) categories.push('graveyards');
      if (categories.length > 0) {
        effects.push({ type: 'farewell', categories, description: `Choose: exile ${categories.join(', ')}` });
      }
    }
    // Exile all artifacts (standalone)
    if (/exile all artifacts/.test(allText) && !/choose one or more/i.test(allText)) {
      effects.push({ type: 'board_wipe', subtype: 'exile_all_artifacts', description: 'Exile all artifacts' });
    }
    // Exile all enchantments (standalone)
    if (/exile all enchantments/.test(allText) && !/choose one or more/i.test(allText)) {
      effects.push({ type: 'board_wipe', subtype: 'exile_all_enchantments', description: 'Exile all enchantments' });
    }
    // One-sided exile: "exile each artifact and each creature your opponents control"
    if (/exile.*each artifact and each creature your opponents control/.test(allText) || /exile each.*your opponents control/.test(allText)) {
      const lifeCondMatch2 = allText.match(/at least (\d+) more life than your starting life total/);
      const lifeThreshold2 = lifeCondMatch2 ? parseInt(lifeCondMatch2[1]) : 0;
      effects.push({ type: 'board_wipe', subtype: 'exile_opponent_artifacts_creatures', lifeThreshold: lifeThreshold2, exileSelf: false, description: 'Exile opponent\'s artifacts & creatures' });
    }
    // Return all creatures to owners' hands (Whelming Wave, Evacuation, etc.)
    const bounceAllMatch = allText.match(/return all (creatures|nonland permanents|permanents)(?:\s+(?:you don't control\s+))?to their owners?[''']?s? hands?/);
    if (bounceAllMatch) {
      const whatToBounce = bounceAllMatch[1]; // 'creatures', 'nonland permanents', 'permanents'
      // Check for exceptions: "except for Krakens, Leviathans, Octopuses, and Serpents"
      const exceptMatch = allText.match(/except (?:for )?(.+?)(?:\.|$)/);
      const exceptions = exceptMatch ? exceptMatch[1].split(/,\s*(?:and\s+)?/).map(s => s.trim().toLowerCase()) : [];
      const opponentOnly = /you don't control/.test(allText);
      effects.push({
        type: 'board_wipe', subtype: 'bounce_all',
        target: whatToBounce, exceptions, opponentOnly,
        description: opponentOnly
          ? `Return all ${whatToBounce} you don't control to hand`
          : `Return all ${whatToBounce} to hand${exceptions.length ? ` (except ${exceptions.join(', ')})` : ''}`
      });
    }
    // Deals X damage to each creature (Blasphemous Act, Anger of the Gods, etc.)
    const dmgEachCreatureMatch = allText.match(/deals? (\d+) damage to each creature/);
    if (dmgEachCreatureMatch) {
      effects.push({ type: 'board_wipe', subtype: 'damage_each_creature', damage: parseInt(dmgEachCreatureMatch[1]), description: `Deal ${dmgEachCreatureMatch[1]} damage to each creature` });
    }
    // Deals X damage to each creature and each player/planeswalker (Star of Extinction etc.)
    const dmgEachAllMatch = allText.match(/deals? (\d+) damage to each creature and each (?:player|planeswalker)/);
    if (dmgEachAllMatch && !dmgEachCreatureMatch) {
      effects.push({ type: 'board_wipe', subtype: 'damage_each_creature', damage: parseInt(dmgEachAllMatch[1]), description: `Deal ${dmgEachAllMatch[1]} damage to each creature & player` });
    }
    // Exile top N cards and play them (Light Up the Stage, Act on Impulse, etc.)
    const exileTopPlayMatch = allText.match(/exile the top (\w+) cards? of your library\.?\s*(?:until the end of your next turn|until end of turn),? you may (?:play|cast) (?:those cards|that card|them)/);
    if (exileTopPlayMatch) {
      const numWords = { one: 1, two: 2, three: 3, four: 4, five: 5 };
      const count = numWords[exileTopPlayMatch[1]] || parseInt(exileTopPlayMatch[1]) || 2;
      const untilNextTurn = /until the end of your next turn/.test(allText);
      effects.push({ type: 'exile_top_play', count, untilNextTurn, description: `Exile top ${count} and play them` });
    }

    // Prevent all combat damage (Fog, Tangle, Settle the Wreckage-style)
    if (/prevent all combat damage/.test(allText)) {
      effects.push({ type: 'prevent_combat_damage', description: 'Prevent all combat damage this turn' });
    }

    // Add mana to mana pool (Dark Ritual, Seething Song, Pyretic Ritual, etc.)
    // Matches patterns like "add {B}{B}{B}", "add {R}{R}{R}{R}{R}", "add {C}{C}", "add three mana of any one color"
    const addManaMatch = allText.match(/add\s+(\{[wubrgc]\}(?:\{[wubrgc]\})*)/);
    if (addManaMatch) {
      const manaStr = addManaMatch[1];
      const manaToAdd = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
      const symbolMatches = manaStr.match(/\{([wubrgc])\}/g) || [];
      for (const sym of symbolMatches) {
        const color = sym.replace(/[{}]/g, '').toUpperCase();
        if (manaToAdd[color] !== undefined) manaToAdd[color]++;
      }
      const totalMana = Object.values(manaToAdd).reduce((a, b) => a + b, 0);
      if (totalMana > 0) {
        const manaDesc = symbolMatches.map(s => s.toUpperCase()).join('');
        effects.push({ type: 'add_mana', mana: manaToAdd, description: `Add ${manaDesc}` });
      }
    }
    // "add X mana of any one color" / "add X mana of any color" (e.g. Irencrag Feat)
    if (!addManaMatch) {
      const addAnyMatch = allText.match(/add (\w+) mana of any (?:one )?color/);
      if (addAnyMatch) {
        const numWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
        const amount = numWords[addAnyMatch[1]] || parseInt(addAnyMatch[1]) || 1;
        effects.push({ type: 'add_mana_choice', amount, description: `Add ${amount} mana of any one color` });
      }
    }

    // Each opponent loses life (e.g. Gary)
    const eachLoseMatch = allText.match(/each opponent loses (?:that much|(\d+)) life/);
    if (eachLoseMatch || /each opponent loses.*life.*equal/.test(allText)) {
      effects.push({ type: 'each_opponent_loses_life', description: 'Each opponent loses life' });
    }

    // Create token (e.g. Advent of the Wurm "Create a 5/5 green Wurm creature token with trample")
    const createTokenMatch = allText.match(/create\s+(?:a|an|two|three|four)\s+(\d+)\/(\d+)\s+([\w\s,/]+?)\s+creature\s+token(?:\s+with\s+([\w\s,]+))?/i);
    if (createTokenMatch) {
      const count = /^(two|three|four)/i.test(allText.match(/create\s+(two|three|four)/i)?.[1] || '') ?
        ({ two: 2, three: 3, four: 4 })[allText.match(/create\s+(two|three|four)/i)[1].toLowerCase()] : 1;
      const power = parseInt(createTokenMatch[1]);
      const toughness = parseInt(createTokenMatch[2]);
      const colorAndType = createTokenMatch[3].trim();
      const keywordsStr = createTokenMatch[4] || '';
      const keywords = keywordsStr ? keywordsStr.split(/,\s*| and /).map(k => k.trim()).filter(Boolean) : [];
      // Extract the token creature type (last word of colorAndType, e.g. "green Wurm" → "Wurm")
      const parts = colorAndType.split(/\s+/);
      const tokenTypeName = parts[parts.length - 1];
      effects.push({
        type: 'create_token',
        count,
        tokenData: {
          name: tokenTypeName,
          isToken: true,
          type_line: `Token Creature — ${tokenTypeName}`,
          power, toughness,
          keywords,
          tapped: false,
          counters: {},
          enteredThisTurn: true,
        },
        description: `Create ${count > 1 ? count + ' ' : 'a '}${power}/${toughness} ${tokenTypeName} token${keywords.length ? ' with ' + keywords.join(', ') : ''}`,
      });
    }

    return effects;
  };

  const parseArenaDecklist = (text) => {
    const lines = text.trim().split('\n');
    const entries = [];
    let inSideboard = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check for "Sideboard" header (case-insensitive)
      if (trimmed.toLowerCase() === 'sideboard') {
        inSideboard = true;
        continue;
      }

      // Check for blank line separator (indicates main deck end if not already in sideboard)
      if (!trimmed && !inSideboard && i > 0 && i < lines.length - 1) {
        // Check if next non-empty line looks like a card
        let nextIdx = i + 1;
        while (nextIdx < lines.length && !lines[nextIdx].trim()) nextIdx++;
        if (nextIdx < lines.length) {
          const nextLine = lines[nextIdx].trim();
          if (nextLine && !nextLine.toLowerCase().startsWith('sideboard') && /^\d+\s+/.test(nextLine)) {
            // Found blank line with card after — likely deck/sideboard separator
            inSideboard = true;
            continue;
          }
        }
      }

      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;

      // Split on ">>" for reskin
      let cardPart = trimmed;
      let reskin = null;
      const reskinIdx = trimmed.indexOf('>>');
      if (reskinIdx !== -1) {
        cardPart = trimmed.substring(0, reskinIdx).trim();
        const reskinStr = trimmed.substring(reskinIdx + 2).trim();
        const parts = reskinStr.split('|').map(s => s.trim());
        reskin = {
          customName: parts[0] || null,
          customImage: parts[1] || null,
          customTokenName: parts[2] || null,
          customTokenImage: parts[3] || null,
          fullCardImage: parts[4] || null,
        };
      }

      // Supports: "4 Lightning Bolt", "4 Island (ZNR) 271", "4 Island (ZNR)", "4 Card (SET) 1★"
      const match = cardPart.match(/^(\d+)\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\)(?:\s+(\S+))?)?$/);
      if (match) {
        entries.push({
          qty: parseInt(match[1], 10),
          name: match[2].trim(),
          set: match[3] ? match[3].toLowerCase() : null,
          collectorNumber: match[4] || null,
          reskin: reskin,
          inSideboard: inSideboard,
        });
      }
    }
    return entries;
  };

  const isCreature = (card) => card.type_line && card.type_line.toLowerCase().includes('creature');

  const isLand = (card) => card.type_line && card.type_line.toLowerCase().includes('land');

  const isInstant = (card) => card.type_line && card.type_line.toLowerCase().includes('instant');

  const isArtifact = (card) => card.type_line && card.type_line.toLowerCase().includes('artifact');

  const isEnchantment = (card) => card.type_line && card.type_line.toLowerCase().includes('enchantment');

  const isPlaneswalker = (card) => card.type_line && card.type_line.toLowerCase().includes('planeswalker');


  // ── getOracleText (moved from index.html) ──
  const getOracleText = (card) => {
    const main = card.oracle_text || '';
    const faces = (card.card_faces || []).map(f => f.oracle_text || '');
    return [main, ...faces].filter(Boolean).join('\n').toLowerCase();
  };

  // ── parsePlaneswalkerAbilities (moved from index.html) ──
  const parsePlaneswalkerAbilities = (card) => {
    const oracle = card.oracle_text || '';
    const faces = card.card_faces || [];
    const allText = [oracle, ...faces.map(f => f.oracle_text || '')].filter(Boolean).join('\n');
    const abilities = [];
    // Try format 1: with brackets [+1]:, [-2]:, [0]:, [−6]:
    const bracketRegex = /\[([+\-\u2212]?\d+)\]:\s*([^\n]+(?:\n(?!\[)[^\n]*)*)/g;
    let match;
    while ((match = bracketRegex.exec(allText)) !== null) {
      const cost = match[1].replace('\u2212', '-'); // normalize unicode minus
      const text = match[2].trim();
      abilities.push({ cost, text });
    }
    // Fallback format 2: without brackets — +1:, −2:, 0: (Scryfall sometimes omits brackets)
    if (abilities.length === 0) {
      const noBracketRegex = /(?:^|\n)([+\-\u2212]\d+|0):\s*([^\n]+(?:\n(?![+\-\u2212]\d+:|0:|\[)[^\n]*)*)/g;
      while ((match = noBracketRegex.exec(allText)) !== null) {
        const cost = match[1].replace('\u2212', '-');
        const text = match[2].trim();
        abilities.push({ cost, text });
      }
    }
    if (abilities.length === 0 && isPlaneswalker(card)) {
      console.warn('PW ability parse failed for:', card.name, 'oracle:', allText.substring(0, 200));
    }
    return abilities;
  };

  // ── parseETBEffects (moved from index.html) ──
  const parseETBEffects = (card) => {
      const allText = getOracleText(card);
      if (!allText.includes('enters the battlefield') && !allText.includes('enters, ')) return [];
      // Extract the ETB sentence(s) AND their immediate continuation sentences.
      // Some cards split ETB effects across multiple sentences:
      //   e.g. Seasoned Pyromancer: "When ~ enters the battlefield, discard two cards, then draw two cards.
      //         For each nonland card discarded this way, create a 1/1 red Elemental creature token."
      // The second sentence is a continuation of the ETB effect but doesn't contain "enters".
      // Strategy: include ETB sentences + the sentence immediately following each ETB sentence.
      const sentences = allText.split(/(?<=\.)\s+|\n/);
      const etbIndices = new Set();
      sentences.forEach((s, i) => {
        if (/enters the battlefield|enters,/.test(s)) {
          etbIndices.add(i);
          // Include the next sentence as a continuation (for multi-sentence ETB effects)
          if (i + 1 < sentences.length) etbIndices.add(i + 1);
        }
      });
      if (etbIndices.size === 0) return [];
      const etbText = [...etbIndices].sort((a, b) => a - b).map(i => sentences[i]).join(' ');
      const effects = [];
      // Damage to target player or planeswalker (Viashino Pyromancer)
      const dmgPlayerPWMatch = etbText.match(/enters.*(?:deals?|it deals) (\d+) damage to target (player or planeswalker|opponent or planeswalker)/);
      if (dmgPlayerPWMatch) {
        effects.push({ icon: '🔥', text: `Deal ${dmgPlayerPWMatch[1]} damage to target ${dmgPlayerPWMatch[2]}`, actionType: 'etb_damage_player_pw', damage: parseInt(dmgPlayerPWMatch[1]) });
      }
      // Damage to opponent/player (generic)
      const dmgMatch = !dmgPlayerPWMatch && etbText.match(/enters.*(?:deals?|it deals) (\d+) damage to (?:target )?(opponent|player|each opponent|any target)/);
      if (dmgMatch) effects.push({ icon: '🔥', text: `Deal ${dmgMatch[1]} damage to ${dmgMatch[2]}` });
      // Opponent loses life
      const loseLifeMatch = etbText.match(/enters.*(?:target )?(?:opponent|player) loses (\d+) life/);
      if (loseLifeMatch) effects.push({ icon: '💀', text: `Target opponent loses ${loseLifeMatch[1]} life` });
      // Each opponent loses life (Gary-style)
      const eachLoseMatch = etbText.match(/enters.*each opponent loses (?:life equal to|(\d+) life)/);
      if (eachLoseMatch) effects.push({ icon: '💀', text: eachLoseMatch[1] ? `Each opponent loses ${eachLoseMatch[1]} life` : 'Each opponent loses life equal to devotion' });
      // Gain life
      const lifeMatch = etbText.match(/enters.*gain (\d+) life/);
      if (lifeMatch) effects.push({ icon: '💚', text: `Gain ${lifeMatch[1]} life` });
      // Draw cards
      const drawMatch = etbText.match(/enters.*draw (\w+|\d+) cards?/);
      if (drawMatch) effects.push({ icon: '📘', text: `Draw ${drawMatch[1]} card(s)` });
      // Destroy/exile target
      if (/enters.*destroy target/.test(etbText)) effects.push({ icon: '💀', text: 'Destroy target permanent' });
      if (/enters.*exile target/.test(etbText)) effects.push({ icon: '🚫', text: 'Exile target permanent' });
      // Return to hand (bounce)
      if (/enters.*return target.*to.*hand/.test(etbText)) effects.push({ icon: '🤚', text: 'Return target to hand' });
      if (/enters.*return up to \w+ target.*to.*hand/.test(etbText)) effects.push({ icon: '🤚', text: 'Return target(s) to hand' });
      // +1/+1 counters
      if (/enters.*\+1\/\+1 counter/.test(etbText)) effects.push({ icon: '⬆', text: 'Put +1/+1 counter(s)' });
      // Create token — match both "enters...create" and continuation sentences like "create a X/Y ... creature token"
      if (/create/.test(etbText)) {
        const tokenMatch = etbText.match(/create (\w+) (\d+)\/(\d+) (\w[\w ]*?) creature token/);
        if (tokenMatch) {
          const qty = tokenMatch[1] === 'a' ? 1 : tokenMatch[1] === 'two' ? 2 : tokenMatch[1] === 'three' ? 3 : parseInt(tokenMatch[1]) || 1;
          const tPower = tokenMatch[2];
          const tToughness = tokenMatch[3];
          const tDesc = tokenMatch[4].trim();
          const colorMap = { 'white': 'W', 'blue': 'U', 'black': 'B', 'red': 'R', 'green': 'G' };
          const tColors = [];
          for (const [cName, cCode] of Object.entries(colorMap)) {
            if (tDesc.toLowerCase().includes(cName)) tColors.push(cCode);
          }
          const typeWords = tDesc.replace(/white|blue|black|red|green|and/gi, '').trim().split(/\s+/).filter(Boolean);
          const tokenTypeName = typeWords.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Token';
          // Extract oracle text from "with ..." clause
          const withMatch = etbText.match(/creature token with ['\u2018\u2019""]([^'"\u2018\u2019""]+)['\u2018\u2019""]/);
          const tokenOracle = withMatch ? withMatch[1] : '';
          effects.push({
            icon: '✦', text: `Create ${qty > 1 ? qty + 'x ' : ''}${tPower}/${tToughness} ${tokenTypeName} token(s)`,
            actionType: 'create_token', tokenQty: qty, tokenPower: tPower, tokenToughness: tToughness,
            tokenName: tokenTypeName, tokenColors: tColors, tokenOracle,
            tokenTypeLine: `Token Creature — ${tokenTypeName}`,
          });
        } else {
          effects.push({ icon: '✦', text: 'Create token(s)' });
        }
      }
      // Search library for land (Solemn Simulacrum, Farhaven Elf, etc.)
      if (/enters.*search your library for a basic land/i.test(etbText)) {
        const tapped = /tapped/.test(etbText);
        effects.push({ icon: '🔍', text: `Search library for a basic land${tapped ? ' (tapped)' : ''}`, actionType: 'search_basic_land', tapped });
      } else if (/enters.*search your library for a land/i.test(etbText)) {
        const tapped = /tapped/.test(etbText);
        effects.push({ icon: '🔍', text: `Search library for a land${tapped ? ' (tapped)' : ''}`, actionType: 'search_land', tapped });
      }
      // Discard
      if (/enters.*discard/.test(etbText)) effects.push({ icon: '🗑', text: 'Target discards' });
      // Scry/surveil
      if (/enters.*scry (\d+)/.test(etbText)) effects.push({ icon: '🔮', text: 'Scry' });
      // Name-based fallback for known ETB token creators (in case regex doesn't capture them)
      const cardName = (card.name || '').toLowerCase();
      const hasTokenEffect = effects.some(e => e.actionType === 'create_token');
      if (!hasTokenEffect) {
        if (cardName === 'seasoned pyromancer') {
          effects.push({
            icon: '\u2726', text: 'Discard 2, draw 2. Create 1/1 Elemental for each nonland discarded',
            actionType: 'create_token', tokenQty: 2, tokenPower: '1', tokenToughness: '1',
            tokenName: 'Elemental', tokenColors: ['R'], tokenOracle: '',
            tokenTypeLine: 'Token Creature \u2014 Elemental',
          });
        }
      }
      // Generic ETB — if none matched but it mentions "enters the battlefield"
      if (effects.length === 0 && (etbText.includes('enters the battlefield') || etbText.includes('enters, '))) {
        // Extract a short snippet of the ETB ability
        const etbMatch = etbText.match(/(when.*?enters.*?(?:\.|$))/);
        if (etbMatch) effects.push({ icon: '\u26a1', text: etbMatch[1].slice(0, 80) });
      }
      return effects;
    };

  // ── getLandManaColors (moved from index.html, Etape 4 groundwork) ──
  const getLandManaColors = (card) => {
    if (card.produced_mana && card.produced_mana.length > 0) {
      return card.produced_mana.filter(c => ['W', 'U', 'B', 'R', 'G', 'C'].includes(c));
    }
    // Fallback: check type line for basic land types
    const tl = (card.type_line || '').toLowerCase();
    const colors = [];
    if (tl.includes('plains')) colors.push('W');
    if (tl.includes('island')) colors.push('U');
    if (tl.includes('swamp')) colors.push('B');
    if (tl.includes('mountain')) colors.push('R');
    if (tl.includes('forest')) colors.push('G');
    return colors.length > 0 ? colors : ['C'];
  };

  // ── calculateDevotion (moved from index.html, Etape 4 groundwork) ──
  const calculateDevotion = (battlefield) => {
    const devotion = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const card of battlefield) {
      if (isLand(card)) continue; // Lands don't contribute to devotion
      let costStr = card.mana_cost || '';
      if (card.layout === 'adventure' && card.card_faces?.[0]) {
        costStr = card.card_faces[0].mana_cost || '';
      }
      const symbols = costStr.match(/\{([WUBRG])\}/g) || [];
      for (const sym of symbols) {
        const color = sym.charAt(1);
        if (devotion.hasOwnProperty(color)) devotion[color]++;
      }
      // Hybrid mana counts for both colors
      const hybrids = costStr.match(/\{([WUBRG])\/([WUBRG])\}/g) || [];
      for (const h of hybrids) {
        const c1 = h.charAt(1);
        const c2 = h.charAt(3);
        if (devotion.hasOwnProperty(c1)) devotion[c1]++;
        if (devotion.hasOwnProperty(c2)) devotion[c2]++;
      }
    }
    return devotion;
  };

  // ── parseDevotionText (moved from index.html, Etape 4 groundwork) ──
  const parseDevotionText = (text) => {
    const colorMap = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
    const match = text.match(/devotion to (\w+)/i);
    if (!match) return null;
    const color = colorMap[match[1].toLowerCase()];
    if (!color) return null;
    const numWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const thresholdMatch = text.match(/devotion to \w+ is (\w+) or more/i);
    let threshold = null;
    if (thresholdMatch) {
      const val = thresholdMatch[1].toLowerCase();
      threshold = numWords[val] || parseInt(val) || null;
    }
    return { color, colorName: match[1], threshold };
  };

  // ── getDevotionInfo (moved from index.html, Etape 4 groundwork) ──
  const getDevotionInfo = (card) => {
    const text = card.oracle_text || '';
    if (card.card_faces) {
      for (const face of card.card_faces) {
        if ((face.oracle_text || '').toLowerCase().includes('devotion')) {
          return parseDevotionText(face.oracle_text);
        }
      }
    }
    if (!text.toLowerCase().includes('devotion')) return null;
    return parseDevotionText(text);
  };

  // ── getBasePower (moved from index.html, Etape 4 groundwork) ──
  const getBasePower = (card) => {
    if (card.power !== undefined && card.power !== null) return card.power;
    if (card.card_faces && card.card_faces[0]) return card.card_faces[0].power;
    return undefined;
  };

  // ── getBaseToughness (moved from index.html, Etape 4 groundwork) ──
  const getBaseToughness = (card) => {
    if (card.toughness !== undefined && card.toughness !== null) return card.toughness;
    if (card.card_faces && card.card_faces[0]) return card.card_faces[0].toughness;
    return undefined;
  };

  // ── hasBasePT (moved from index.html, Etape 4 groundwork) ──
  const hasBasePT = (card) => getBasePower(card) !== undefined;

  // ── isSorcery (moved from index.html, Etape 4 groundwork) ──
  const isSorcery = (card) => card.type_line && card.type_line.toLowerCase().includes('sorcery');

  // ── isSpellCard (moved from index.html, Etape 4 groundwork) ──
  const isSpellCard = (card) => isInstant(card) || isSorcery(card);

  // ── isAdventureCard (moved from index.html, Etape 4 groundwork) ──
  const isAdventureCard = (card) => card.layout === 'adventure' && card.card_faces && card.card_faces.length >= 2;

  // ── isSaga (moved from index.html, Etape 4 groundwork) ──
  const isSaga = (card) => card.type_line && card.type_line.toLowerCase().includes('saga');
  const api = {
    parseManaCost,
    canPayManaCost,
    deductManaCost,
    parseSpellEffects,
    parseArenaDecklist,
    isCreature,
    isLand,
    isInstant,
    isArtifact,
    isEnchantment,
    isPlaneswalker,
    getOracleText,
    parsePlaneswalkerAbilities,
    parseETBEffects,
    getLandManaColors,
    calculateDevotion,
    parseDevotionText,
    getDevotionInfo,
    getBasePower,
    getBaseToughness,
    hasBasePT,
    isSorcery,
    isSpellCard,
    isAdventureCard,
    isSaga,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    // Expose as globals so the Babel block's existing call sites resolve here.
    Object.assign(window, api);
    window.RulesCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
