# Tap & Go — Spilleguide

Denne guide forklarer hvordan du bruger spillet rent praktisk. Den forudsætter at du kender Magic: The Gathering's regler.

---

## 1. Start et spil

Når du åbner spillet ser du online-lobbyen, hvor du kan oprette eller joine et spil mod en ven over nettet.

### Opret et rum

1. Indtast dit navn og tryk **Continue**
2. Klik **Create New Game** — du får en 4-6 cifret rumkode
3. Del koden eller det fulde link med din modstander (der er en kopieringsknap)
4. Vent på at de joiner

### Join et rum

1. Indtast dit navn og tryk **Continue**
2. Klik **Join Existing Game**
3. Indtast rumkoden du har fået
4. Klik **Join**

---

## 2. Vælg et deck

Du har tre muligheder:

- **Preset Decks** — vælg mellem 8 færdige decks i to sværhedsgrader (klik et deck, det loader automatisk fra Scryfall)
- **Paste Decklist** — indsæt en Arena-format deckliste (f.eks. `4 Lightning Bolt`)
- **Build Custom Deck** — søg kort på Scryfall og byg dit deck manuelt

### Færdige decks

**Level 1** (begyndervenlige): White Knight, Black Devotion, Green Power, Red Aggro, Blue Control

**Level 2** (avancerede): Azorius Control, Boros Burn, Simic Control (Pokemon)

Når dit deck er loadet, klik **Submit Deck & Ready Up**. Vent på at modstanderen også er klar.

---

## 3. Coin flip og mulligan

Spillet slår automatisk plat/krone. Vinderen starter. Derefter får begge spillere mulighed for London Mulligan:

- **Keep Hand** — behold din hånd
- **Mulligan** — shuffle hånden tilbage og træk én færre

Startspilleren beslutter først. Derefter modstanderen.

---

## 4. Spillebrættet — overblik

```
┌─────────────────────────────────────────────┐
│  Modstander: Liv / Poison / Mana            │
│  [Modstanderens battlefield]                 │
│─────────────────────────────────────────────│
│  [Din battlefield]                           │
│  Dit navn: Liv / Poison / Mana              │
│  [Din hånd - kort i bunden]                 │
└─────────────────────────────────────────────┘
```

- **Øverst**: Modstanderens kort, liv og mana pool
- **Nederst**: Dine kort, din hånd, og kontroller
- **Midten**: Begge spilleres battlefield
- **Hjørnerne**: Knapper til Graveyard, Exile, Emblems, Tokens

---

## 5. Grundlæggende handlinger

### Spil et kort fra hånden

**Venstre-klik** på et kort i din hånd:

- **Land** → lander direkte på battlefield (maks 1 per tur)
- **Creature/Enchantment/Artifact** → castes (mana trækkes automatisk fra din mana pool)
- **Instant/Sorcery** → castes til stakken
- **Adventure-kort** → du får valget mellem adventure-siden eller hovedkortet
- **Modal spell (choose one)** → du vælger mode inden kortet castes (f.eks. Decisive Denial)
- **Overload-spell** → du vælger mellem normal cost (single target) eller overload cost (mass effect)

### Tap og untap

- **Venstre-klik** på et kort på battlefield → tapper/untapper det
- Kort roterer 90° når de er tappet
- Ved tur-start untappes alle dine kort automatisk

### Mana

- **Klik på et tappet land** → tilføjer mana til din pool baseret på landets farve
- **Pain lands** (f.eks. Caves of Koilos, Battlefield Forge) → giver 1 skade automatisk når du vælger farvet mana
- Mana pool vises som tal øverst (W:2 U:1 B:0 R:3 G:0 C:0)
- Mana brugt automatisk ved casting
- Mana pool nulstilles ved tur-skift

---

## 6. Højreklik-menu (den vigtigste funktion!)

**Højreklik på ethvert kort** åbner en kontekstmenu med alle tilgængelige handlinger. Menuen ændrer sig afhængigt af *hvor* kortet er og *hvem* der ejer det.

### Kort på DIN battlefield

- **Tap / Untap** — skift tapped-status
- **+1/+1 Counter / -1/-1 Counter** — tilføj counters
- **Remove [type] Counter** — fjern en specifik counter
- **Temp Buff (until end of turn)** — indtast +X/+X midlertidigt
- **Temp Keywords** — giv midlertidige keywords (f.eks. flying, trample)
- **Prevent all damage until next turn** — forhindrer al combat-skade (og triggers som Relic Robber)
- **To Hand / To Graveyard / To Exile** — flyt kortet
- **To Top of Library / To Bottom of Library** — læg kortet tilbage
- **Attach to creature** — for auras og equipment
- **Clone Token** — kopier et token
- **Destroy Token** — fjern et token
- **Sacrifice abilities** — abilities der kræver sacrifice (f.eks. Cursecatcher)
- **Paid abilities** — abilities der koster mana (f.eks. Midnight Clock)

### Kort på MODSTANDERENS battlefield

- **-1/-1 Counter** — tilføj counter (f.eks. efter Infect-skade)
- **Prevent all damage** — forhindrer en modstanders creature i at deale skade
- **Gain Control (permanent)** — tag kontrol over kortet
- **Gain Control (until end of turn)** — midlertidig kontrol (Act of Treason-stil)
- **Return to Hand / To Graveyard / To Exile** — fjern kortet

### Kort i GRAVEYARD (højreklik i graveyard-vieweren)

- **Flashback / Jump-Start / Escape / Disturb / Unearth** — cast fra graveyard med alternativ cost
- **Create Token Copy** — opret en token-kopi af en creature
- **To Hand / To Battlefield** — hent kort tilbage

### Kort i EXILE

- **Cast Foretold** — cast et foretold kort til reduceret cost
- **Cast Adventure Creature** — cast creature-siden efter adventure-spellen
- **Create Token Copy** — opret en token-kopi
- **To Hand / To Battlefield / To Graveyard** — flyt kort fra exile

### Kort i HÅNDEN

- **Cast** — cast kortet
- **Cast — Spectacle** — brug alternativ spectacle-cost (hvis betingelsen er opfyldt)
- **Cycle** — discard og træk et kort (for kort med cycling)
- **Foretell** — exil face-down, cast senere til reduceret cost
- **To Graveyard / To Exile / To Top/Bottom of Library** — discard/flyt

---

## 7. Combat — angrib og bloker

### Trin 1: Erklær angribere

1. Klik **Combat** knappen i dit spillerområde
2. **Klik på dine utappede creatures** for at vælge dem som angribere (de highlightes)
3. Klik igen for at fravælge
4. Klik **Confirm Attackers** — valgte creatures tappes automatisk (undtagen med Vigilance)

### Trin 2: Planeswalker-mål (hvis modstanderen har planeswalkers)

Hvis modstanderen har planeswalkers på bordet:

- For hver angriber kan du vælge om den angriber **spilleren** eller en **specifik planeswalker**
- Klik den relevante knap for hvert target
- Klik **Confirm Targets**

### Trin 3: Modstanderen kan respondere

Modstanderen får mulighed for at caste instants/flash inden blockers.

### Trin 4: Blocker-deklaration

Forsvarende spiller:

1. **Klik på din utappede creature** (den highlightes som "blocker")
2. **Klik på en angribende creature** for at tildele blokkeren
3. Gentag for flere blockers
4. Klik **Confirm Blockers**

### Trin 5: Skade

Skade udregnes automatisk:

- First Strike og Double Strike udregnes først
- Trample-overflow rammer spilleren
- Deathtouch kræver kun 1 skade for at dræbe
- Lifelink healer dig
- Infect giver -1/-1 counters til creatures og poison til spillere
- Creatures der dør sendes automatisk til graveyard
- Combat-triggers (f.eks. Relic Robber) fyrer kun hvis skade faktisk blev dealt — forhindret skade (Kiora +1) tæller ikke

---

## 8. Instants, Flash og "Respond"

Denne sektion er vigtig at forstå.

### Hvornår kan du caste instants?

- **I din tur**: altid (klik kortet i hånden)
- **I modstanderens tur**: når spillet giver dig et "respond"-vindue

### Respond-vinduet

Når modstanderen gør noget du kan respondere på (caster et spell, erklærer angribere), popper et overlay op der viser:

- Dine castbare instants og flash-creatures
- Din nuværende mana pool
- **Klik et kort** for at caste det
- **Klik udenfor** eller **Esc** for at lukke uden at caste noget

### Counter-spells (automatisk)

Counter-spells håndteres **automatisk** af spillet:

1. Modstanderen caster et spell → det vises på stakken
2. Du klikker **Respond** → respond-vinduet åbner
3. Tap dine lands for mana, og klik dit counterspell → det lægges oven på stakken
4. Modstanderen ser nu **to spells** på stakken og klikker **Resolve**
5. Spillet detekterer automatisk at det er et counterspell og counters det underliggende spell → begge sendes til graveyard

### Counter-wars (counter mod counter)

Stakken understøtter ubegrænsede niveauer af responses:

1. Spiller A caster en creature → stakken: [Creature]
2. Spiller B responderer med Counterspell → stakken: [Creature, Counterspell]
3. Spiller A responderer med Dovin's Veto → stakken: [Creature, Counterspell, Dovin's Veto]
4. Spiller B klikker **Resolve** på Dovin's Veto → Counterspell counters → stakken: [Creature]
5. Spiller B klikker **Resolve** på Creature → den lander på battlefield

### "Can't be countered" (Dovin's Veto, Koma, m.fl.)

Kort med "can't be countered" er beskyttet. Hvis du prøver at countre dem, fizzler dit counterspell, og det beskyttede spell forbliver på stakken.

---

## 9. Planeswalkers

### Aktivér en ability

**Højreklik på din planeswalker** → menuen viser:

- **Grøn** = du har nok loyalty til at aktivere
- **Rød** = for lidt loyalty (kan ikke klikkes)
- Klik en ability → loyalty justeres automatisk
- Der vises en påmindelse med ability-teksten

### Auto-execute effekter

Visse planeswalker-abilities udføres automatisk:

- **Board wipes** (f.eks. "destroy all creatures") → klik **Execute Effect**
- **Emblems** → klik **Create Emblem**
- **Kiora's +1** → vælg target for damage prevention direkte, eller "No target" for kun loyalty
- **Jace's +1 debuff** → klik **Activate Effect**
- Andre effekter → klik **OK — Execute Manually** og udfør dem selv

### Skade til planeswalkers

- Angribere kan rettes mod planeswalkers i combat (se sektion 7, trin 2)
- Spells der dealer skade til "player or planeswalker" eller "creature or planeswalker" kan også ramme dem
- Skade fjerner loyalty counters. Planeswalker destrueres ved 0 loyalty.

---

## 10. Mana Rocks og Artifact Abilities

### Tap for mana (Mind Stone, Sol Ring, Arcane Signet, etc.)

Artifacts med "{T}: Add {mana}" fungerer ligesom lands: **klik for at tappe**, og mana tilføjes automatisk til din pool.

### Sacrifice-abilities (Mind Stone: "{1}, {T}, Sacrifice: Draw a card")

**Højreklik → Sacrifice: Draw a card** — mana betales automatisk, kortet flyttes til graveyard, og effekten udføres.

### Betalte aktiverede abilities (Midnight Clock: "{2}{U}: Put an hour counter")

**Højreklik → Add hour counter ({2}{U})** — mana betales automatisk, og effekten udføres.

---

## 11. Specielle mekanikker

### Scry / Surveil

Når en scry/surveil-effekt udløses, vises et overlay med de øverste kort af dit library:

- Klik **Keep on Top** for at beholde et kort ovenpå
- Klik **Bottom** (scry) eller **Graveyard** (surveil) for at sende det væk
- Klik **Confirm** når du er færdig

### Overload (f.eks. Cyclonic Rift)

Kort med overload viser en valgmulighed ved casting:

- **Normal cost** → single target (f.eks. bounce ét nonland permanent)
- **Overload cost** → mass effect (f.eks. bounce ALLE modstanderens nonland permanents)
- Hvis du ikke har mana nok til overload, er knappen grå og deaktiveret
- Overloaded spells vises med "OVERLOADED" label på stakken

### Modal Spells (Choose One)

Spells med "choose one" (f.eks. Decisive Denial) viser en modal valgmulighed:

- Vælg den mode du vil bruge
- Kortet castes derefter med den valgte mode
- Counter-mode lægger spellen på stakken, kamp-mode kræver targets

### Foretell

1. **Højreklik i hånden → Foretell** — exiler kortet face-down (koster {2})
2. Næste tur: **Højreklik i exile → Cast Foretold** — cast til reduceret foretell-cost

### Creature lands (f.eks. Den of the Bugbear, Crawling Barrens)

**Højreklik → Activate as X/X** for at animere et land til en creature:

- Koster mana (vises i menuen)
- Crawling Barrens har to muligheder: kun counters (permanent) eller fuld aktivering
- Ved tur-slut reverterer creature lands automatisk (undtagen permanent lands som Crawling Barrens)

### Board wipes

Når du caster en board wipe (f.eks. Wrath of God):

- Spil kortet normalt fra hånden
- Hvis spillet genkender effekten → klik **Execute Effect** i påmindelsesoverlayet
- Ellers: **højreklik → To Graveyard** på hvert kort manuelt

### Equipment og Auras

- **Attach**: Højreklik udstyret/auraen → **Attach to creature** → klik target-creature
- **Move**: Højreklik → **Move to other creature** → klik ny creature
- **Detach**: Højreklik → **Detach**

---

## 12. Zoner — graveyard, exile, library

### Se graveyard

Klik **Graveyard** knappen → åbner en oversigt. Herfra kan du højreklik for flashback, escape, osv.

### Se exile

Klik **Exile** knappen → viser alle exilede kort. Højreklik for at flytte kort.

### Se library

Dit library vises som en stak. Du kan ikke se kortene (undtagen ved scry-effekter).

---

## 13. Liv og poison

- **Pil op/ned** ved dit livs-tal → justér op/ned med 1
- Samme for poison counters
- Combat-skade justerer automatisk

### Spillets slut

Spillet registrerer automatisk:
- Liv ≤ 0 → du taber
- Poison ≥ 10 → du taber
- Commander damage ≥ 21 fra én kilde → du taber (kun Commander-format)

---

## 14. Tur-flow

1. **Untap** — dine kort untappes automatisk
2. **Draw** — du trækker automatisk ét kort
3. **Main Phase 1** — spil lands, cast creatures/spells
4. **Combat** — klik Combat for at gå i combat
5. **Main Phase 2** — spil mere efter combat
6. **End Turn** — klik **End Turn** knappen

Modstanderen får en "respond"-mulighed inden turen faktisk skifter.

---

## 15. Chat

I online-tilstand er der en chat-funktion:

- Skriv en besked i chat-feltet nederst
- Tryk Enter for at sende
- Beskeder forsvinder efter 8 sekunder fra skærmen

---

## 16. Disconnect, reconnect og exit

### Disconnect

Hvis en spiller mister forbindelsen:

- Den anden spiller ser: **"Opponent disconnected — waiting for reconnection..."**
- Spilleren kan genåbne linket og joiner automatisk igen
- Spillets tilstand bevares
- Rooms ryddes automatisk efter 5 minutter uden spillere

### Exit Game

- Klik **Exit Game** for at forlade rummet og vende tilbage til lobbyen
- Du kan oprette eller joine et nyt spil derfra

---

## Hurtig-reference

| Handling | Sådan gør du |
|---|---|
| Spil kort fra hånd | Venstre-klik |
| Tap/untap | Venstre-klik på battlefield-kort |
| Tilføj mana | Klik tappet land |
| Alle handlinger | Højreklik → kontekstmenu |
| Angrib | Combat → klik creatures → Confirm |
| Bloker | Klik din creature → klik angriber |
| Cast instant | Klik i respond-vinduet |
| Counter et spell | Respond → cast counterspell → Resolve |
| Tap mana rock | Klik artefaktet (som et land) |
| Sacrifice ability | Højreklik → Sacrifice: [effekt] |
| Betalt ability | Højreklik → [effekt] |
| Planeswalker ability | Højreklik → vælg ability |
| Counters | Højreklik → +1/+1 eller -1/-1 |
| Se graveyard | Klik Graveyard |
| Opret token | Klik + Token |
| End turn | Klik End Turn |
| Exit game | Klik Exit Game |

---

*Sidst opdateret: Marts 2026*
