# padel-push

Riktiga pushnotiser för padel.holmberg.st. En Cloudflare Worker (gratisplanen) kollar RankedIn varje minut
medan en tävling pågår och skickar Web Push till alla som slagit på Notiser – även när appen är stängd.

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

Den privata nyckeln finns bara som hemlighet hos Cloudflare. Tappar du den: ta bort `vapid-public.txt`
och kör skriptet igen (alla får då slå på Notiser på nytt).

## Tävlingar hittas automatiskt

Workern letar själv upp allt Thea och Kian anmäler sig till på RankedIn (`src/discover.js`):
turneringar (klass, partner, lottning, gruppspel eller slutspel) och lagserier som SPL (lagets
matcher, en post per speldag). Listan uppdateras en gång i timmen (minut 7) och sparas i KV under
`disc`. Den skrivs bara om när något ändrats, eller var sjätte timme.

- `GET /events` ger listan (sidan läser den var 30:e minut).
- Under speldagen (07:00–23:00 svensk tid, från första till sista dagen) kollas lottningen eller
  lagmatchen varje minut. Nya resultat blir push till alla som slagit på Notiser.
- Max 30 anrop till RankedIn per minut. Pågår flera tävlingar samtidigt turas de om.
- Lottning: en gång i timmen (minut 37) kollas varje turneringsklass som börjar inom 7 dagar. När lottningen
  dyker upp kommer en notis ("Lottningen klar: ..."). KV `pub:<klass>` = "0"/"1", skrivs bara vid ändring.
  Första titten är utgångsläge (ingen notis).
- Ny tid eller bana för Theas/Kians nästa match under speldagen ger en notis ("Ny tid: ...").
- Notisernas länk går direkt till matchen: `./#thea/m<MatchId>`. Sidan byter flik och visar matchen.
- `GET /events` har också `past`: tävlingar som tagit slut de senaste 60 dagarna.
- Workern får bara exportera funktioner (workerd vägrar starta annars), se test i `features.test.mjs`.

`src/events.js` finns kvar som reserv: en rad där läggs till i listan (samma klass + spelare vinner
det som hittats automatiskt). Normalt behöver du inte röra den.

## Testa

```sh
cd worker
npm install
npm test                 # kryptering (RFC 8291/8292), notistexter, KV-logik, automatisk sökning, lagserier
E2E_PORT=18951 node test/e2e-dev.mjs    # wrangler dev lokalt: prenumerera, kör cron, ta emot och dekryptera en push
```
