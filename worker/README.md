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
- Skydd: `/subscribe` och `/unsubscribe` max 5 per minut och IP, övriga anrop 60 (`[[ratelimits]]` i
  `wrangler.toml`), högst 500 prenumerationer. Origin-kollen skyddar bara mot andra webbsidor.
- Notisernas länk går direkt till matchen: `./#thea/m<MatchId>`.
- Workern får bara exportera funktioner (workerd vägrar starta annars), se test i `features.test.mjs`.

## Följa och notiser

Sidan skickar `prefs: {follow: [pid, ...]}` med prenumerationen, och igen när man ändrar vilka man följer.
Varje enhet får bara notiser om spelarna den följer: spelarens egna matcher, lottning, tider och ranking
(aldrig lagkamraters eller andras matcher). Två följda spelare i samma match eller lagmatch ger en notis,
inte två. Gamla prenumerationer med `{thea, kian}` betyder Thea (1675246) och Kian (1680004).

Bilder: små runda (`.av`) ligger i `img/av/` (150 px, beskurna): `python3 worker/avatars.py img/<namn>.jpg [x% y%]`.
Service workern visar sparade bilder direkt och hämtar om dem i bakgrunden, så en utbytt bild syns vid nästa visning.

`src/events.js` finns kvar som reserv: en rad där läggs till i listan (samma klass + spelare vinner
det som hittats automatiskt). Normalt behöver du inte röra den.

## Testa

```sh
cd worker
npm install
npm test                 # kryptering (RFC 8291/8292), notistexter, KV-logik, automatisk sökning, lagserier, följa
E2E_PORT=19011 node test/e2e-dev.mjs    # wrangler dev lokalt: prenumerera, kör cron, ta emot och dekryptera en push
# sidan i Chromium (Playwright), RankedIn och workern mockade:
(cd .. && python3 -m http.server 19021 --bind 127.0.0.1) &
NODE_PATH=$(npm root -g) node test/page-e2e.mjs
```
