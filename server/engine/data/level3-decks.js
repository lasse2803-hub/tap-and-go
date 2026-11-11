/**
 * Level 3 decks designed in chat (2026-07). Not yet in the client's PRESET_DECKS —
 * they live here so the engine simulator covers them. Same list format as the
 * client presets. Final versions: Izzet without The Royal Scions (+4 Reckless
 * Charge), Mono-Green with Fanatic of Rhonas (not Karametra's Acolyte), Golgari
 * without Pernicious Deed (not Modern/Historic legal).
 */
module.exports = [
  {
    name: 'Izzet Wizards',
    level: 3,
    description: 'Dreadhorde Arcanist + Reckless Charge, burn and card flow',
    list: `4 Soul-Scar Mage (AKR)
4 Ledger Shredder (SNC)
4 Dreadhorde Arcanist (WAR)
3 Adeliz, the Cinder Wind (DOM)
3 Balmor, Battlemage Captain (DMU)
4 Wizard's Lightning (DOM)
4 Reckless Charge (TSR)
4 Consider (MID)
4 Expressive Iteration (STX)
3 Play with Fire (MID)
2 Counterspell (MH2) 267
4 Steam Vents (GRN)
4 Spirebluff Canal (KLD)
3 Riverglide Pathway (ZNR)
1 Otawara, Soaring City (NEO)
5 Island (THB) 251
4 Mountain (THB) 253`,
  },
  {
    name: 'Mono-Green Nissa',
    level: 3,
    description: 'Devotion ramp into Nissa planeswalkers and Polukranos',
    list: `4 Llanowar Elves (DOM)
4 Elvish Mystic (M15)
3 Fanatic of Rhonas (AKR)
4 Old-Growth Troll (KHM) 365
3 Polukranos Reborn (THB)
3 Cavalier of Thorns (M20)
3 Voracious Hydra (M20)
3 Nissa, Who Shakes the World (WAR)
2 Nissa, Ascended Animist (MOM)
1 Nissa of Shadowed Boughs (ZNR)
1 Ugin, the Ineffable (WAR)
1 Ugin, the Spirit Dragon (M15)
4 Cultivate (STA)
4 Nykthos, Shrine to Nyx (THS)
20 Forest (THB) 254`,
  },
  {
    name: 'Golgari Nissa Control',
    level: 3,
    description: 'Ramp, removal and board wipes into Nissa and big finishers',
    list: `4 Llanowar Elves (DOM)
4 Elvish Mystic (M15)
3 Binding the Old Gods (KHM)
3 Glissa Sunslayer (ONE)
2 Grist, the Hunger Tide (MH2)
3 Nissa, Who Shakes the World (WAR)
2 Nissa of Shadowed Boughs (ZNR)
1 Nissa, Ascended Animist (MOM)
2 Grave Titan (M21)
1 Massacre Wurm (2X2)
2 Night's Whisper (2X2)
3 Assassin's Trophy (GRN)
2 Infernal Grasp (MID)
2 Damnation (2X2)
2 Extinction Event (IKO)
4 Overgrown Tomb (GRN)
4 Woodland Cemetery (DKA)
3 Darkbore Pathway (KHM)
2 Deathcap Glade (VOW)
2 Blooming Marsh (KLD)
1 Llanowar Wastes (ORI)
4 Forest (THB) 254
4 Swamp (THB) 252`,
  },
];
