# Concurrentie-analyse — collection- & deckbuild-apps (aug 2026)

> Antwoord op **ANSWERS A2**: "wat lijkt jou de beste manier om het toegankelijk te houden maar ook
> interessant genoeg om te proberen — doe eerst een concurrentie-analyse." Onderzoek 2026-08-04, bronnen
> onderaan. Beslisvoorstel in §4; de beslissing zelf staat open als **A8** in SESSION-PROMPT.md.

## 1. Het veld

| App | Focus | Gratis | Premium | Prijs | Collection-aware aanbevelingen? |
|---|---|---|---|---|---|
| **Moxfield** | Deckbuilder (de standaard) | Vrijwel alles | Analytics, extra's (Patreon) | ~$3.99/mnd · $39/jr | Nee — collectie "feels like an afterthought", geen scanner |
| **Archidekt** | Deckbuilder + collectie | Vrijwel alles | Patreon-perks (~4.8k betalende leden) | v.a. ~$2/mnd | Nee — owned-filter bestaat, maar EDHRec-recs kunnen bij hen **technisch niet** collection-aware worden (eigen forum) |
| **EDHRec** | Commander-aanbevelingen | Alles (ads/affiliates) | — | — | Nee — kent het concept "jouw collectie" niet |
| **ManaBox** | Mobiele scanner + collectie | Scanner + zoeken, **cap: 5 decks** | Onbeperkte decks e.a. | paar €/mnd | Nee — sterke scanner, zwakke deck-kant |
| **Dragon Shield Scanner** | Scanner + collectie | Basis | Prijshistorie e.a. | ~€/mnd | Nee — deckbuilder secundair |
| **Deckbox** | Collectie + trade | Veel | Kleine perks | ~$5/**jaar** | Nee — deckbuilder jaren niet bijgewerkt |
| **EchoMTG** | Prijs/portfolio-tracking | **Cap: 360 kaarten** | Volledig | $2–7/mnd | Nee |
| **MTGGoldfish** | Meta & prijzen | Met ads | Meta-tools | $6/mnd | Nee |
| **GrimDeck** (nieuw) | Unified collectie+decks | 10k kaarten | **Scanner achter paywall** | $3.99/mnd · $39/jr | Beperkt; kleine community |
| **ManaStack** | Deckbuilder | Kern | **AI-features achter paywall** | $5/mnd | Nee |
| **CardCastle** | Verkopers-inventory | Beperkt | Commerce-tools | $9/mnd | Nee |
| *Spelkant: SpellTable (WotC)* | Webcam-play op afstand | Gratis | — | — | n.v.t. — geen overlap met couch-play (bord + telefoons in één kamer) |

## 2. Patronen in de markt

1. **Prijsanker: $2–6 per maand**, met Patreon als dominant model bij de twee grootste (Moxfield,
   Archidekt). Boven de $6 zit alleen commerce-gereedschap (CardCastle $9).
2. **De kern is overal gratis**; betaald = convenience/analytics, zelden functionaliteit die je nergens
   anders krijgt. Daardoor is de betaalbereidheid laag maar de verwachting "gratis moet goed zijn" hoog.
3. **Harde caps als drukmiddel werken averechts op goodwill**: ManaBox' 5-deck-cap en EchoMTG's
   360-kaarten-cap zijn de meest genoemde irritaties in reviews.
4. **AI achter een paywall is een geaccepteerd precedent** (ManaStack $5/mnd), net als een scanner
   achter premium (GrimDeck).
5. **Niemand levert collection-aware aanbevelingen.** Archidekt (de enige die het probeerde te koppelen)
   zegt expliciet op het eigen forum dat het EDHRec-endpoint geen notie van collecties heeft en dat
   duizenden kaarten meesturen onhaalbaar is. EDHRec zelf is populatie-statistiek, geen persoonlijk
   advies. Dit is het open gat.

## 3. Positionering LeylineSync

**Het unieke:** de advisor rekent óp je collectie, server-side (eigen DB, geen extern endpoint): welke
commanders kun je NU bouwen, welke upgrades liggen al in je binder, perfect fits per deck — precies wat
Archidekt technisch niet kan. Plus de koppeling die niemand heeft: dezelfde decks zijn direct speelbaar
in de couch-play-omgeving (bord + telefoons). Niet op concurreren: scannen (ManaBox is daar beter en
ManaBox-import bestaat al) en meta-onderzoek (MTGGoldfish).

**Voorwaarde vóór de paywall aangaat** (eerdere vaststelling, jul 2026): de usability-gaten in het
Collection-spoor dichten — decklijst-weergave, touch-preview, versnipperde IA. Een paywall op een
rommelige funnel converteert niet.

## 4. Paywall-voorstel — ✅ **BESLOTEN (A8, 5 aug 2026: "klinkt goed")**

> Grens en prijs hieronder zijn vastgesteld. Bouwvolgorde blijft: eerst de import-funnel/usability (§5),
> dan de premium-tier (Stripe ligt voor de hand; definitieve provider-keuze bij de bouw).

Consistent met de vaste principes: gameplay nooit gated; LLM-calls alleen betaald, met server-side
quota en grounding; het gratis pad blijft heuristisch.

| Feature | Gratis | Premium |
|---|---|---|
| Gameplay (bord, controllers, engine, bots) | **Alles, altijd** | — |
| Collectie-import (ManaBox e.a.) + waarde | Onbeperkt — géén kaarten-cap (bewust anti-EchoMTG/GrimDeck) | — |
| Deck-CRUD + insights + legality | Volledig | — |
| Buildable commanders (heuristisch) | **Top 3 zichtbaar** (teaser met "nog N verborgen") | Volledige lijst + alle kleuren/filters |
| Upgrade-scan / perfect fits per deck | 1 deck | Alle decks, batch |
| AI-deckgeneratie & AI-suggesties | — | Inbegrepen, met dagquotum (bv. 10 generaties/dag) |
| Shop-links (Cardmarket e.a.) | Gratis (affiliate = eigen inkomsten) | — |

- **Prijs: €3,99/mnd of €35/jaar** — exact op het Moxfield/GrimDeck-anker; niet goedkoper (waardeloos
  signaal), niet duurder (geen merk nog).
- **Waarom dit werkt:** het betaalde deel is het enige in de markt dat je nérgens anders kunt krijgen
  (collection-aware advies), terwijl gratis ruimhartiger is dan de concurrentie op precies de punten
  waar zij irriteren (geen caps op kaarten of decks). Gameplay gratis houden voedt de funnel:
  spelen → collectie importeren → "je kunt 12 commanders bouwen, 3 zichtbaar" → conversie.
- **Werknaam tier:** "Leyline Premium" (naamgeving vrij te kiezen).

## 5. Import-funnel: hoe krijgen mensen hun collectie erin (besproken 2026-08-04)

Het knelpunt is niet techniek — de parsers bestaan (ManaBox-CSV met Scryfall-ID-match, decklijsten,
Moxfield/Archidekt-URL-import) — maar de menskant. Drie groepen, één waardetrap:

1. **Al gedigitaliseerd** (ManaBox/Moxfield/Archidekt): drempel is *weten hoe je exporteert*. Nodig:
   **onboarding-wizard** op `/collection/import` — app kiezen → stap-voor-stap export-instructies met
   screenshots → drag-drop met format-autodetectie.
2. **Alleen papier**: géén eigen scanner bouwen (commodity, maanden werk, ManaBox is gratis en beter).
   De wizard verwijst eerlijk: "scan gratis met ManaBox, exporteer CSV, sleep hier."
3. **Wil alleen spelen**: heeft geen collectie nodig — precon of decklijst/URL plakken. Collectie is een
   optionele verdieping, nooit een onboarding-muur.

**Volgorde is de truc:** spelen (nul invoer) → deck plakken (30 sec) → collectie-import, gemotiveerd
door de advisor-teaser ("importeer en zie welke commanders je nú kunt bouwen") — de teaser moet
zichtbaar zijn vóór de importvraag.

**Her-import (geverifieerd in code):** `import-collection.ts` doet delete-then-insert — een verse export
vervangt alles. Goed sync-model (nooit duplicaten), maar de wizard moet twee dingen doen: (a) uitleggen
"exporteer altijd je héle collectie", en (b) waarschuwen wanneer de nieuwe import fors kleiner is dan de
bestaande collectie (deel-export-voetklem). Plus een "laatst gesynct op …"-datum op de collectiepagina.

Dit is de concretisering van de "usability-gaten eerst"-voorwaarde uit §3.

## 6. Open vragen (→ ANSWERS A8)

1. Akkoord met de gratis/premium-grens hierboven, of grens verschuiven?
2. Prijs €3,99/€35 akkoord?
3. Betaalprovider (Stripe ligt voor de hand) en wanneer: na het dichten van de usability-gaten?

## Bronnen

- https://grimdeck.com/blog/best-mtg-deck-builder-sites (vergelijking + prijzen Moxfield/Goldfish/ManaStack e.a.)
- https://grimdeck.com/blog/best-mtg-collection-trackers (collectie-apps, caps, scanner-paywalls)
- https://www.patreon.com/archidekt (Archidekt-prijs + ledental)
- https://archidekt.com/forum/thread/8339713 ("Edhrec Based on My Collection" — waarom het bij hen niet kan)
- https://www.scanyourmtg.com/review/manabox/ + Google Play/App Store-pagina's ManaBox (5-deck-cap, premium)
- https://edhrec.com/guides/how-to-use-edhrec (EDHRec-model: populatiedata, gratis)
