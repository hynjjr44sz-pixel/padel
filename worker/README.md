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

## Lägga till en tävling

Öppna `src/events.js` och lägg till en rad i `EVENTS`:

```js
{
  who: "thea",                       // "thea" eller "kian" (fliken notisen öppnar)
  me: "Thea Holmberg Löving",        // namnet exakt som på RankedIn
  cls: "Dam B",                      // klassens namn i notiserna
  tournamentId: 73554, classId: 173729,
  stages: [0, 1],                    // valfritt: 0 = lottning/grupper, 1 = slutspel efter grupper
  activeFrom: "2026-10-09T16:00:00+02:00", activeTo: "2026-10-11T23:00:00+02:00"
}
```

- **classId** står i RankedIn-adressen när du klickar på klassen (`.../draws?tournamentClassId=173729`).
- Tider är svensk tid: `+02:00` på sommartid, `+01:00` efter sista söndagen i oktober.
- Kör `./worker/deploy.sh` igen. Klart.

Utanför fönstret gör workern ingenting. Skriv fönstret så kort det går: varje minut i fönstret är ett anrop till RankedIn.

## Testa

```sh
cd worker
npm install
npm test                 # kryptering (RFC 8291/8292), notistexter, KV-logik
node test/e2e-dev.mjs    # wrangler dev lokalt: prenumerera, kör cron, ta emot och dekryptera en push
```
