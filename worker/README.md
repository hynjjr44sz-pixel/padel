# padel-push

Riktiga pushnotiser för padel.holmberg.st. En Cloudflare Worker (gratisplanen) kollar RankedIn varje minut
medan en tävling pågår och skickar Web Push till dem som följer spelaren och slagit på Notiser, även när
appen är stängd.

## Första gången

1. Skapa ett gratiskonto på cloudflare.com. Öppna **Workers & Pages** en gång (då får kontot en workers.dev-adress).
2. Skapa en API-token: *My Profile → API Tokens → Create Token → mallen "Edit Cloudflare Workers"*.
   Kopiera också ditt *Account ID* (står till höger på kontots översiktssida).
3. Kör från repots rot:

   ```sh
   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./worker/deploy.sh
   ```

   Skriptet skapar KV-lagringen, nycklarna och workern, och skriver in adressen i `index.html` (`PUSH_API`).
4. Committa och pusha `index.html`, `worker/wrangler.toml` och `worker/vapid-public.txt`.
5. Öppna sidan, slå av och på **Notiser** en gång.

Den privata nyckeln finns bara som hemlighet hos Cloudflare. Skriptet gör aldrig nya nycklar av sig självt när
de redan finns (och stannar om det inte kan läsa hemligheterna). Tappar du nyckeln: kör skriptet med
`ROTATE_VAPID=1` (alla får då slå på Notiser på nytt).

`index.html` har en Content-Security-Policy där sidans skript släpps in med sin hash. `npm test` och `deploy.sh`
räknar om den (`node worker/csp.mjs`); ändrar du skriptet utan att köra någon av dem startar sidan inte.

## Spelarna: players.json

Truppen står i `players.json` i repots rot (en rad per spelare: `key` = adressen på sidan, `#thea`,
`pid` = RankedIn-id, lag, bild). Sidan läser filen direkt. Workern får en kopia, `src/players.js`, som
`node sync-players.mjs` skriver (körs av `npm test` och `deploy.sh`; ett test larmar om de glider isär).
Ny spelare: lägg till en rad i `players.json`, kör testerna och deploya.

## Tävlingar hittas automatiskt

Workern letar själv upp allt spelarna anmäler sig till på RankedIn (`src/discover.js`): turneringar
(en post per spelare och klass: partner, lottning, gruppspel eller slutspel) och lagserier som SPL (en post
per lag och speldag, med lagets spelare i `pids`). Var tionde minut (minut 7, 17, ...) kollas fyra spelare,
i tur och ordning, så varje spelare kollas minst var 40:e-50:e minut. Max 35 anrop till RankedIn per körning
(15 medan något pågår, 30 första gången), och det som delas (turneringsinfo, lagets matcher) hämtas en gång per körning.
Ett lag hämtas när lagets första spelare i `players.json` kollas (inte för varje lagkamrat). En pågående turnering
(eller en som börjar inom 48 h) kollas bara i spelarens kända klasser, inte i alla klasser.
Listan sparas i KV under `disc` och skrivs bara om när något ändrats, eller var sjätte timme.

- `GET /events` ger listan (sidan läser den var 30:e minut), `past` (tävlingar som tagit slut de senaste
  60 dagarna), `latest` (senaste resultaten för klubbens spelare) och `live` (per spelare: nästa match eller
  hur dagen slutade). `latest` och `live` kommer från bevakningen nedan och kostar inga extra KV-skrivningar.
- `wins` (Veckans vinnare): klasser som en klubbspelare vunnit (`place: 1`, finalen i huvudlottningen eller ensam grupp
  i en ren gruppspelsklass) eller förlorat finalen i (`place: 2`), de senaste 30 dagarna: klass, turnering, datum,
  `pids`, paret, motståndarna, resultat och länk. Workern ser det när finalen fått en vinnare (sparas då också i
  klassens `st:<klass>`) och lägger till det i KV `wins`, som bara skrivs när något nytt kommer till. En gång i timmen
  (minut 44) kollas också klassernas sparade läge för tävlingar de senaste 9 dagarna (bara KV-läsningar), så en vinst
  som missades eller hände innan koden fanns kommer med ändå. Sidan visar vinsten på "Nynäs idag" och i spelarens
  toppruta från finaldagen till och med 8:e dagen efter.
- Under speldagen (07:00–23:00 svensk tid, aldrig på natten) kollas varje klass och lagmatch varje minut när en
  ospelad match den dagen börjar inom 30 minuter eller har börjat (lagmatch: från 30 minuter före start), en gång
  för alla klubbens spelare i den. Annars var tionde minut: dagar klassen inte spelar, före lottningen eller
  laguppställningen, och när allt är avgjort (då i två timmar, sedan inte alls). Max 30 anrop till RankedIn per
  minut. Pågår mer samtidigt turas de om. Klassens nya läge sparas först när notiserna gått iväg.
- Lottning: en gång i timmen (minut 35) kollas varje turneringsklass som börjar inom 7 dagar, inom 48 h var
  15:e minut (5, 20, 35, 50). När lottningen dyker upp kommer en notis ("Lottningen klar: ..."). KV `pub:<klass>` =
  "0" eller lottningarna (`[[steg, styrka], ...]`), skrivs bara vid ändring; bevakningen hämtar lottningarna härifrån
  (ett slutspel som läggs till under tävlingen kommer med).
- Ny tid eller bana för spelarens nästa match under speldagen ger en notis ("Ny tid: ...").
- Ranking: minut 52 varje timme, en fråga per lista (dam, herr) så länge listans datum är det i KV
  `rankdate:<typ>:<ålder>`; ny lista: en fråga per spelare (max 20 per timme). Ny SPF-lista ger en notis.
- `board` (Topplistan på "Nynäs idag"): per spelare `sk` (SPF-skill), `w`/`l`/`y` (årets vunna/förlorade dubbelmatcher och
  året), `rk`/`rp`/`rd` (SPF-placering, poäng, listans datum) och `up` (platser uppåt på listan, RankedIns `StandingDiff`).
  Ligger i `disc` (ingen extra KV-läsning för `/events`). W–L läses ur profilen som discovery ändå hämtar (inga extra
  anrop). Placeringen kommer från rankingkollen (minut 52) när en spelares rad ändras, skill från `GetPlayerRatingAsync`
  för 6 spelare i timmen i tur och ordning (hela truppen var 3:e timme, 6 anrop i timmen). `disc` skrivs bara när
  tavlan ändrats. Första gången efter en deploy fylls placeringen i från `rank:<pid>` (bara KV-läsningar, en gång).
- Förslag på tävlingar (`src/calendar.js`): varje natt 03:23–03:38 svensk tid byggs en kalender över SPF-sanktionerade
  turneringar som börjar inom 8 veckor, högst 20 mil från Nynäshamn (SPF:s kalender med radie 200 km, sedan `GetInfoAsync`
  och `GetClassesSectionAsync` per turnering). Max 40 anrop per minut, fortsätter nästa minut (KV `calw`, ett par skrivningar
  per natt). Avstånd: turneringens koordinater (haversine), annars den minsta radien (20–160 km) som listar den ("inom 3 mil").
  Klassgränserna (parets poäng: 2 × poängen för rad 61/201/1201 herr, 51/161/701 dam) läses om när listan är en vecka gammal
  (6 anrop). Anmälda klubbspelare tas ur discovery (inga extra anrop). KV `cal` skrivs bara när något ändrats; `GET /cal`
  (cache 1 h) ger den. Sidan räknar ut förslagen per spelare med samma regler (`eligibility`, `suggestFor`).
- Skydd: `/subscribe` och `/unsubscribe` max 5 per minut och IP, `/live` 600 (många telefoner på samma wifi i hallen),
  övriga anrop 60 (`[[ratelimits]]` i `wrangler.toml`), högst 5000 prenumerationer. Origin-kollen skyddar bara mot andra
  webbsidor. `/fanout` kräver hemligheten `FANOUT_KEY` (403 annars, och avstängd utan den).
- Notisernas länk går direkt till matchen: `./#thea/m<MatchId>`.
- Workern får bara exportera funktioner (workerd vägrar starta annars), se test i `features.test.mjs`.

## Live-relä: RankedIn hämtas en gång, delas ut till alla

Bevakningen ovan hämtar redan varje pågående klass och lagmatch från RankedIn varje minut. Det sidan behöver av det
(lottningarna rensade till de fält sidans modell läser, samma `KEEP`-lista som `index.html`, ett test håller dem lika;
lagmatchens rubbers som de är) sparas i **en** KV-nyckel, `live` (`src/relay.js`), och `GET /live?ids=164681,tm167486`
ger `{v, at, every, items: {id: {v, at, dr, data}}, sk: {pid: {rid: skill}}}`. Sidan läser det under en pågående tävling
i stället för RankedIn (samma regler för dold flik som förut). Saknas klassen i reläet (t.ex. en tävling workern inte
hittat än), svarar workern fel, eller säger den `shed`, frågar sidan RankedIn direkt som förut (med den delade
30-sekunderscachen `riGet`); efter ett fel i 5 minuter, efter `shed` i 30.

- `live` skrivs högst en gång per minut och bara när något ändrats. Ett nytt resultat, ny tid eller bana (det som också
  ger notiser) skrivs direkt; annat (t.ex. ett liveresultat under matchen) högst var 3:e minut. Max 400 skrivningar per dag:
  vid taket töms reläet (sidan frågar RankedIn själv) till nästa dag.
- `every`: 60 sekunder när en match i klassen pågår eller börjar inom 30 minuter, annars 300. Sidan väntar så länge
  mellan hämtningarna.
- Oförändrat: `ETag` + `If-None-Match` ger 304 (sidan hämtar med `cache: "no-cache"`, webbläsaren frågar med ETag),
  `since=<v>` ger `{v, same: 1}`.
- Varje isolat läser `live` ur KV högst var 25:e sekund och bygger svaret som text (lottningarna parsas inte per anrop).
- Skill för spelarna i pågående lottningar: var 10:e minut (minut 3, 13, ...) högst 20 `GetPlayerRatingAsync`, bara för
  spelare vars värde är äldre än 3 h, inom tickens budget. Sidan tar dem ur `sk` och frågar inte RankedIn om dem.

## Pushnotiser till många: fan-out

Ticken skickar inte längre notiserna själv. Den bygger en lista (en post per enhet: prenumeration + meddelanden, efter
följa-filtret, sammanslagning per enhet och "N nya resultat"-vikningen som förut) och gör **ett** anrop till sig själv
via service binding `SELF` (`POST /fanout`, header `X-Fanout-Key` = hemligheten `FANOUT_KEY`, som `deploy.sh` gör).
Det anropet delar upp i omgångar om 20 notiser och skickar varje omgång till ett eget anrop (egna 50 underanrop och
10 ms CPU), högst 29 omgångar (Cloudflare tillåter 32 Worker-anrop per request: cron + fördelaren + 29). Omgången
skickar, tar bort prenumerationer som svarar 404/410 (eller vars nycklar inte går att använda) och svarar med antal.
Det som inte får plats, eller en omgång som misslyckas, sparas i KV `outbox` (en nyckel, skrivs bara när den ändrats,
tas bort när den är tom) och går först nästa minut. En notis som väntat en timme (TTL) slängs. Klassens nya läge skrivs
först när notiserna gått iväg eller ligger i `outbox`, så inget skickas två gånger (utom om en omgång dör mitt i:
då kan någon få samma notis igen, med samma tag ersätter den den förra).

Utan `SELF`/`FANOUT_KEY` (lokala tester, första deployen innan hemligheten finns) skickar ticken själv som förut, och det
som inte ryms i budgeten hamnar i `outbox`. Svarar `/fanout` 4xx (avvisat innan något skickats, t.ex. olika hemlighet
mellan versioner) skickar ticken också själv; vid 5xx/nätverksfel kan omgångar redan ha gått, så då väntar allt i `outbox`. `FANOUT_URL` (workerns egen adress) kan ersätta bindningen i `wrangler dev`
om den inte fungerar där (det gör den i wrangler 4, se e2e-testet).

Prenumerationerna sparas också som KV-metadata på nyckeln, så fan-outen läser alla enheter med en `list` per 1000 i
stället för en `get` per enhet (listan hålls 3 minuter per isolat; en ny prenumeration kan alltså missa notiser de
första minuterna). Gamla poster utan metadata skrivs om en gång när sidan öppnas (den skickar `/subscribe` vid varje besök).
En post som blir över 1024 byte som metadata (KV:s gräns, räknat med escapade citattecken) sparas utan och läses med `get`.

## Kapacitet (gratisplanen)

Gränser: 100 000 anrop/dag (allt: cron, fan-out, sidan), 50 underanrop och 10 ms CPU per anrop, KV 100 000 läsningar,
1000 skrivningar, 1000 borttagningar och 1000 list per dag, 32 Worker-anrop per request.

**Notiser.** CPU per krypterad notis (ECDH P-256 + HKDF + AES-GCM) mätt i workerd lokalt: ca 0,25–0,3 ms, plus ca 0,1 ms
för VAPID-signaturen per push-tjänst och omgång. En omgång om 20 notiser ≈ 6–7 ms (40 hade varit 10–12 ms, över gränsen).
Per minut: 29 × 20 = **580 notiser** (en enhet får en notis per minut när många ska ha: vikningen). Fler väntar i
`outbox`: 1200 enheter når alla inom 3 minuter (580 + 580 + 40), 5000 inom 9 (då är `outbox` ett par MB som ticken
läser varje minut, nära CPU-gränsen: räkna med 1000–2000 enheter som bekvämt, 5000 som tak). Ticken använder 1 underanrop för allt
detta (förut ett per notis, max 44 enheter, resten tappades), så RankedIn behåller sin andel (max 30 per minut).
Anrop: 1 + antal omgångar per minut med notiser, t.ex. 300 sådana minuter × 30 = 9 000 av 100 000.
KV: `outbox` läses varje minut (1 440/dag), skrivs bara när den ändras; listning 2 per notisminut vid 1200 enheter
(5 vid 5000, med 3 min cache i isolatet: ca 200–500 av 1000/dag), 404/410 tas bort (max 1000/dag).

**Live-reläet.** RankedIn: inga extra anrop (datat hämtas ändå av bevakningen), skill högst 20 per 10 minuter. KV:
`live` ≤ 1 skrivning per minut, i praktiken en per nytt resultat/ny tid (≈ 100–300 en stor dag), tak 400; läsningar:
ticken 1 per minut, `GET /live` 1 per isolat per 25 s (≈ 2 300 per isolat och dag på 16 h). **Anropen är taket:** varje
synlig app gör 60 anrop/timme medan en match pågår eller är nära, 12 annars. 100 000/dag minus cron (1 440), fan-out och
`/events` räcker till ungefär 80 000 `/live`-anrop: t.ex. 150 appar som står öppna samtidigt i 8 timmar, eller några
tusen användare som tittar till och från. Över 100 `/live`-anrop per minut totalt (rate limit `LIVE_ALL` med en enda
nyckel för alla, räknas per Cloudflare-plats: i praktiken Stockholm) eller 150 i ett isolat svarar workern `{shed: 1}`
och de apparna frågar RankedIn själva i 30 minuter; de som kom igenom behåller reläet. Då blir `/live` högst ca 72 000
anrop på en 12-timmarsdag, så cron och notiser inte svälter. Behövs mer: Workers Paid
(10 miljoner anrop/månad) eller ett eget domännamn med cache framför `/live`.

**Ticken.** RankedIn: högst 30 anrop per minut för bevakningen (oförändrat), + skill (≤ 20, bara om budget finns kvar,
minut 3/13/...), + 1 för fan-outen. KV-skrivningar per dag: klassernas läge (per ändring) + `live` (≤ 400) + `outbox` +
`disc`/`pub`/`rank`/`wins`/`cal` som förut. Simulerad stor dag (3 klasser à 30 matcher + 2 SPL-matcher à 5 matcher,
09–20): `live` ≈ 300, klassernas läge ≈ 200, totalt ≈ 500–550 av 1000.

## Följa och notiser

Sidan skickar `prefs: {follow: [pid, ...]}` med prenumerationen, och igen när man ändrar vilka man följer.
Varje enhet får bara notiser om spelarna den följer: spelarens egna matcher, lottning, tider och ranking
(aldrig lagkamraters eller andras matcher). Två följda spelare i samma match eller lagmatch ger en notis,
inte två. Gamla prenumerationer med `{thea, kian}` betyder Thea (1675246) och Kian (1680004).

Bilder: små runda (`.av`) ligger i `img/av/` (150 px, beskurna): `python3 worker/avatars.py img/<namn>.jpg [x% y%]`.
Spelare utan egen bild (`img`/`avatar` i `players.json`) får sin profilbild från RankedIn: workern läser profilen
(`playerprofileinfoasync`, ett anrop per spelare efter spelarnas tävlingar, inom samma budget) när spelaren kollas,
alltså minst var 40:e-50:e minut, och lägger `{url, thumb, placeholder}` per pid i `disc` (skrivs bara om när något
ändrats) och som `photos` i `GET /events`. RankedIns standardlogga (`placeholder`) visas aldrig; en bild som inte
laddar blir initialer. Egna bilder i `img/` går alltid före. Bilderna kommer från cdn.rankedin.com och RankedIns
Azure-CDN (CSP `img-src`) och cachas av webbläsaren (ny bild = ny adress), inte av service workern.
Service workern visar sparade bilder direkt och hämtar om dem i bakgrunden, så en utbytt bild syns vid nästa visning.

`src/events.js` finns kvar som reserv: en rad där läggs till i listan (samma klass + spelare vinner
det som hittats automatiskt). Normalt behöver du inte röra den.

## Statistik på sidan (utan workern)

- Inbördes möten: före nästa match (hjältens motståndare och korten i spelträdet) visas facit mot paret, räknat ur
  spelarens egna turneringslottningar (de tävlingar Senaste tävlingar listar, högst 12 månader bakåt), och mot var och en för sig från RankedIns
  `GetPlayerSelectedOpponentsStatsAsync` (POST, alla rankade matcher, sparas 24 h, bara för nästa match i hjälten).
- Partners: matcher, V–F och vinstprocent per partner ur samma matcher; bäst (minst 3 matcher, och minst två
  partners att jämföra) markeras. Rubriken visar perioden matcherna täcker ("Sedan 26 apr" eller "12 mån").
  Kunde en klass inte hämtas visas det, och "Första mötet" sägs inte förrän alla klasser är räknade.
- Matcherna hämtas klass för klass bara när spelarsidan behöver dem (nästa match, eller Partners på skärmen), aldrig
  när sidan är dold. En avslutad klass ändras aldrig och sparas (`padel.mh.v1.<pid>`); listan ses över efter 24 h.
  Lottningar som redan finns på enheten återanvänds.

## Testa

```sh
cd worker
npm install
npm test                 # kryptering (RFC 8291/8292), notistexter, KV-logik, automatisk sökning, lagserier, följa, relä, fan-out
E2E_PORT=19111 node test/e2e-dev.mjs    # wrangler dev lokalt: prenumerera, kör cron, fan-out via SELF, GET /live, dekryptera push
# sidan i Chromium (Playwright), RankedIn och workern mockade:
(cd .. && python3 -m http.server 19021 --bind 127.0.0.1) &
NODE_PATH=$(npm root -g) node test/page-e2e.mjs
```
