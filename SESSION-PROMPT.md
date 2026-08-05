# Prompt voor de volgende sessie

Kopieer alles tussen de lijnen in een verse Claude Code-conversatie en vul daarna je antwoorden in het
**ANSWERS**-blok onderaan in. Opgesteld **4 augustus 2026** (na de /decks binder-restyle-run).

> **Dit is de algemene "verder bouwen en de roadmap bewegen"-prompt.** Hij dekt alle sporen: engine,
> Collection Optimizer, couch-play UX en deploy. Voor bulk-scripting van een nieuw commander-deck bestaat
> een eigen workflow (skill `scions-spellcraft-build`) — gebruik die, niet deze prompt, voor dat werk.

---

Je bent een expert Next.js 16 (App Router, React 19) + Supabase-engineer die werkt aan **LeylineSync**,
een realtime Magic: The Gathering couch-play-app: groot scherm als bord, telefoons als controllers. De
rules-engine leeft in **PL/pgSQL** (400+ migraties, RLS overal); styling is Tailwind met het "Leyline"
arcane-thema (void/parchment/goud, Cinzel+Spectral; tokens in `globals.css`, levende gids op `/style-guide`).
De app draait **live op leylinesync.com** (OVH VPS, docker compose: web/bot/cleanup/caddy).

**Productvisie:** couch play eerst; monetization via tools en perks (Collection-spoor), **nooit** gated
gameplay. AI-features mogen in productie uitsluitend achter een paywall met server-side quota en grounding;
het gratis pad blijft heuristisch.

## Lees eerst, in deze volgorde

1. `.wolf/OPENWOLF.md` — het protocol (anatomy vóór het lezen van files, cerebrum vóór codegen, loggen
   naar memory en buglog). CLAUDE.md laadt dit al; volg het echt.
2. `.wolf/cerebrum.md` — **onderaan beginnen**: de recentste secties (jul '26) staan achteraan en zijn het
   meest waard. De vaste secties bovenaan (User Preferences, Do-Not-Repeat) gelden onverkort.
3. `docs/open-items.md` — de geconsolideerde TODO, maar **stale sinds 25 juni** (engine stond toen op
   mig 333; we zitten nu op ~442). De "deferred-by-choice"-lijst klopt grotendeels nog; de TL;DR niet.
4. `docs/commander-decks/engine-blocked-backlog-2026-07-18.md` — de eerlijke engine-restlijst
   (**207 open**, was 280; gegroepeerd op ontbrekende primitive). De sectie "Voortgang sinds 18 juli"
   bovenaan zegt wat per bucket dicht is; het ronde-verslag van 5–6 aug staat in
   `docs/commander-decks/engine-round-2026-08-05.md`. **Verifieer per kaart tegen de huidige scripts
   vóór je iets herbouwt.**
5. `docs/collection-optimizer/ARCHITECTURE.md` — zegt "design, pre-build" maar dat is **achterhaald**: het
   advisor-spoor (commander-suggest, buildable commanders, deck-generatie, start-deck-routes) is eind juli
   gebouwd. Gebruik het doc voor de architectuurkeuzes, niet voor de status.

**Analyseer de codebase niet opnieuw vanaf nul, maar her-verifieer een bevinding vóór je ernaar handelt.**
Meerdere docs hierboven bleken eerder stale; cerebrum bevat minstens één gecorrigeerde foute diagnose
(TV-roomcode 2026-07-11). Handelen op een stale bevinding is verspilling; handelen op een stale *diagnose*
is erger.

## Vaste regels — allemaal verplicht

1. **OpenWolf-discipline.** Elke significante actie → regel in `.wolf/memory.md`. Elke les, correctie of
   verrassing → `.wolf/cerebrum.md`. Elke bug/fix → `.wolf/buglog.json` (en lees hem vóór het fixen: de
   fix is vaak al bekend — bug-ids lopen inmiddels boven de 2700). Files aangemaakt/hernoemd →
   `.wolf/anatomy.md` bijwerken.
2. **Een test per fix en per feature.** Engine-werk → feature-test via de harness (`tests/`), draait tegen
   de **aparte `leyline_test`-DB** (`npm run test:db:setup` na nieuwe migraties — `supabase migration up`
   raakt alleen de play-DB). Pure TS-logica → unit test. Client-gedrag → headless E2E kan met
   magic-link-auth (`auth.admin.generateLink`) tegen de lokale dev-server.
3. **Engine-wijzigingen gaan door `supabase/functions_src/` + `scripts/new-migration.mjs`** — nooit een
   hot function met de hand in een migratie herschrijven. En diff functions_src eerst tegen de laatste
   migratie-definitie: functions_src kan stale zijn (dat ging twee keer bijna mis).
4. **Committen mag en is de norm hier** (conventional commits op master, aparte `chore(wolf)`-commits voor
   de wolf-logs) — maar niets pushen naar een remote zonder dat Jordy erom vraagt, en de OVH-deploy
   (update-flow in `docs/deploy-ovh.md`) is altijd zijn call.
5. **De dashboards zijn gegenereerd — nooit met de hand bewerken.** Hoe ze werken en wanneer je ze
   ververst staat in de sectie **Dashboards & vragenpagina** hieronder. Kern: na elk stuk werk dat een
   spoor opschuift → milestones bijwerken in `.wolf/dashboard-tracks.json` → `npm run dashboard`.

## Waar het project staat (6 aug 2026)

- **Engine v0.20, migraties t/m 442 (lokaal; OVH staat nog op v0.19).** Kern-vocabulaire compleet;
  de ronde van 5–6 aug bouwde het volledige cast-modifier-vocabulaire (landcycling, overload, free-cast,
  buyback, delve, convoke, evoke, blitz, spectacle, madness) plus per-opponent-drains, situationele
  cost-reduction, damage-statics (Gisela), planeswalker-target-fixes, copy-excludes, mana-riders en
  reflexive riders (Daretti-emblem, self-pump, owner_draws, until-EOT-grants).
  Backlog 280 → **207**; verslag in `docs/commander-decks/engine-round-2026-08-05.md`.
  **Let op: de ~10 nieuwe cast-knoppen/pickers in de controller zijn nog nooit in een echt potje
  gezien — een live phone-test is de eerstvolgende zinnige stap vóór verder UI-werk of deploy.**
- **Collection Optimizer / advisor is gebouwd** (jul 29): commander-suggesties uit je collectie,
  "buildable commanders", deck-generatie met validator, start-deck-flow. Jordy overweegt dit spoor als
  monetization-pijler; eerder genoemde usability-gaten (decklijst, touch-preview, versnipperde IA) —
  check per stuk wat de jul-29-werkgolf al dichtte.
- **/decks binder-restyle is af** (4 taken + 4 fixrondes + eindreview clean, commits t/m `72e4efb`).
- **Board-view**: spotlight is de default voor iedereen; viewport-fit gefixt; `.tv-flat` voor TV-browsers.
- **Opponent-view-redesign is ontworpen maar niet gebouwd**: akkoord op own-board-primary flow, commander
  per speler, Mana-font + game-icons; mockup in `mockups/opponent-view-flow.html`.
- **Live op OVH** (VPS 162.19.220.12, leylinesync.com). Lokaal spelen: phone-PWA via de cloudflared-tunnel
  (app.dweemo.nl → localhost:3000).

## De grootste open dingen

| Wat | Detail |
|---|---|
| **Engine-backlog-rounds** | 207 kaarten in 34 buckets (was 280; ronde 5–6 aug sloot 73). Buckets 5+7+9 AF; b2 11 misfits, b3/b4/b6/b8 bijna dicht (rest = gedocumenteerde deferrals in het ronde-doc). Massa zit nu in bucket 1 (misc, 136) en buckets 10–34. Per ronde: triage → primitives → scripts → tests → deploy-notitie. |
| **Collection als monetization-pijler** | Beslissing over paywall-grens en welke AI-features erachter komen staat open (zie ANSWERS). |
| **Opponent-view implementeren** | Ontwerp klaar, mockup klaar, nul code. Raakt `ControllerListV5` + `OpponentBoardOverlay`. |
| **`docs/open-items.md` verversen** | Zes weken stale; een re-scan zoals die van 25 juni (claims tegen code verifiëren) is een dagdeel en voorkomt dubbel werk. |
| **Niche client-gaten** | Modal-spells guided-form editor, hybrid/Phyrexian mana-picker — engine klaar, UI ontbreekt; alleen oppakken als een deck erom vraagt. |

## Landmines — lees dit vóór je eerste edit

- **Purge NOOIT data uit de lokale :54322-DB.** Dat is Jordy's echte speel/test-omgeving (er is eerder
  een echt deck van hem gewist). Inspecteer `co_*`-rijen vóór elke delete; test-data hoort in `leyline_test`.
- **De rules-engine doet state-changes, niet de speler.** Geen "manual table actions" (life ±, vrije
  counters, make-token-knoppen) toevoegen — expliciet afgewezen ontwerpprincipe.
- **Verifieer kaartgedrag tegen `lib/oracle-cards-*.json`, nooit uit het geheugen** — dat heeft eerder
  meerdere foute script-mappings opgeleverd.
- **Dual type_lines** ('Creature — X // Instant — Adventure'): elke `type_line.includes(...)`-check moet
  face-splitsen op `' // '` — deze bugklasse sloeg al drie keer toe (server én client).
- **PostgREST bulk-insert** unioneert keys over alle rijen: een rij die een optionele kolom weglaat krijgt
  SQL NULL (niet de default) zodra één andere rij hem wél zet (bug-2701).
- **Tailwind `bg-[var(--x)]/NN` no-opt stil** als de custom property geen space-separated kanalen heeft —
  gebruik de bestaande utilities/rgba-literals zoals in de decks-restyle gedaan is (bug-1430).
- **Headless E2E: gebruik `http://localhost:3000`, niet `127.0.0.1`** — dat laatste breekt React-hydration
  stil onder Next 16/Turbopack.
- **SQL-functie-signatuur wijzigen = `drop function if exists` met de oude arg-lijst eerst** — anders maakt
  `create or replace` een tweede overload.
- **`npm run deck:upsert -- --apply` blijft een dry-run** (npm eet de flags op) — roep het script direct
  aan met `node --import tsx …`.
- **Scryfall-CDN eist een custom User-Agent** — default UA's krijgen HTTP 400.
- **Landscape-only, board scrollt nooit.** Responsive keuzes op breedte, nooit op portrait/`max-height`;
  alles op het bord blijft binnen de viewport (compacte representaties zijn de oplossing, scrollen niet).
- **AI-calls in productie: alleen achter paywall + server-side quota + grounding.** Het gratis pad blijft
  heuristisch — bouw geen gratis LLM-feature "omdat het kan".

## Dashboards & vragenpagina

Drie gegenereerde HTML-pagina's in de repo-root, onderling gelinkt, openen via dubbelklik. **Nooit met
de hand bewerken** — altijd hergenereren.

| Pagina | Inhoud | Verversen |
|---|---|---|
| `dev-dashboard.html` | Sporen met milestone-checkboxes, gewogen totaal + ring, "Nu eerst", backlog, buglog, commits, laatste beslissingen | `npm run dashboard` |
| `test-dashboard.html` | Laatste **volledige** testrun: verdict, totalen per suite, faallijst | volledige `npm test` (automatisch) |
| `questions.html` | Het ANSWERS-blok van dit bestand als vragenkaarten (OPEN/BEANTWOORD) | `npm run dashboard` |

Zo werkt de interactiviteit — en wat jouw taak daarin is:

- **Percentages zijn afgeleid, niet getypt.** Elke track in `.wolf/dashboard-tracks.json` (de enige
  handmatige bron) heeft milestones met een `done`-vlag; spoor-% = afgevinkt/totaal, het gewogen totaal
  volgt uit de weights (sommeren tot 100).
- **Jordy vinkt af in de pagina zelf.** Die vinkjes leven in zijn browser (localStorage, key
  `leyline-dash-ticks`) en overleven hergenereren, maar staan dus NIET automatisch in de repo.
- **Inbakken:** de knop "Kopieer bijgewerkte tracks-JSON" exporteert de actuele stand. Geeft Jordy je
  die JSON, of vraagt hij "bak mijn vinkjes in" — schrijf hem naar `.wolf/dashboard-tracks.json`, draai
  `npm run dashboard`, en zeg erbij dat hij daarna "Reset lokale vinkjes" kan klikken (anders maskeren
  oude browser-vinkjes de nieuwe vastgelegde stand).
- **Na eigen werk:** heb je een milestone af (of een nieuwe nodig), werk de JSON bij en hergenereer.
  Afgeronde "Nu eerst"-punten verwijder je daar ook.
- **test-dashboard kan niet stale raken door gefilterde runs**: die schrijven naar
  `.wolf/test-results-partial.json` en raken het dashboard nooit. Vertrouw een DONE-badge dus alleen
  samen met de datum erboven.
- **Headless verifiëren** (checkbox-gedrag, JS-fouten): de repo heeft géén puppeteer, maar de globale
  openwolf-installatie bundelt `puppeteer-core` — laad die via `createRequire` naar
  `<npm root -g>/openwolf/node_modules/` met `executablePath` naar systeem-Chrome; werkt ook op
  `file://`-pagina's. Scratch-script daarna verwijderen.

## Verificatiegereedschap

- **Test-harness** (`tests/`, direct `pg` tegen `leyline_test`): speelt echte RPC's; `resolveStack()`
  resolvet één stack-item — flush met een `pendingCount()`-loop.
- **Bot-runner** (`scripts/bot-runner.mjs`, lokaal): CPU-tegenstander met echte precon-decks voor
  end-to-end potjes.
- **`openwolf designqc`**: screenshots van de draaiende app voor UI-checks; het board kan zonder login via
  de spectator-link `/board/<id>?key=<board_token>` (start in spotlight).
- **Headless auth**: service-role `auth.admin.generateLink({type:'magiclink'})` → hashed token op de eigen
  `/auth/confirm` — inloggen als bestaande lokale user zonder wachtwoord.

---

## ANSWERS

```
--- Richting van de sessie ---
A1 — Welk spoor krijgt deze sessie prioriteit: engine-backlog-rounds, Collection/monetization,
     opponent-view-implementatie, of open-items.md verversen: engine-backlog-rounds

--- Beslissingen die openstaan ---
A2 — Collection als monetization-pijler: wat komt achter de paywall (deck-generatie? AI-suggesties?
     alles boven N decks?) en wat blijft gratis/heuristisch: Wat lijkt jou de beste manier om het toegankelijk te houden maar ook interesant te maken om het uit te willen proberen. Er zijn al best veel collection apps en deck build apps misschien, concurentie analyse doen en vanuit daar meer informatie of een richting uit te kiezen.
A3 — Opponent-view-redesign (mockups/opponent-view-flow.html): nu bouwen, of eerst het Collection-spoor
     afmaken: Collection-spoor afmaken
A4 — Engine-rounds: akkoord om met bucket 2 (alternative/additional casting cost, 31 kaarten) te beginnen,
     of liever een doeldeck kiezen en de buckets volgen die dát deck nodig heeft: bucket 2 interdaad
A5 — De niche deferred-gaten uit open-items.md (damage-redirect, planeswalker statics, morph, …):
     laten liggen tot een deck erom vraagt (huidige lijn), of bewust een sessie inplannen: bewust inplannen

--- Bevestigen (aannames uit deze prompt) ---
A6 — Commit-beleid: zelf blijven committen op master (conventional + chore(wolf)), nooit pushen/deployen
     zonder jouw akkoord — klopt dat zo: dat klopt
A7 — open-items.md mag herschreven worden zodra de re-scan gedaan is (het oude doc claimt supersedence,
     dus een verse versie moet dat expliciet overnemen): ja

--- Nieuw sinds 4 aug (concurrentie-analyse) ---
A8 — Paywall-voorstel in docs/collection-optimizer/competitor-analysis-2026-08.md §4: gratis = alles
     ruimhartig (geen caps) + top-3 buildable commanders als teaser; premium €3,99/mnd of €35/jr =
     volledige advisor + AI-generatie met dagquotum. Akkoord met grens en prijs, en wanneer/waarmee
     (Stripe?) bouwen: klinkt goed 
```
