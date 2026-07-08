# Chromecast — custom receiver setup

Real casting from phones (Android Chrome / installed PWA) needs a **registered
Google Cast receiver app**. Web casting of a URL without registration only
works on desktop Chromium (Presentation API), which is the automatic fallback
while no App ID is configured. iOS/Safari has no web casting at all — iPhone
users keep the TV room code (`leylinesync.com/tv`) or AirPlay screen mirroring.

## One-time registration (owner does this once)

1. Go to the [Google Cast SDK Developer Console](https://cast.google.com/publish)
   and sign in — registration costs a **one-time $5**.
2. **Add New Application** → type **Custom Receiver**.
3. Receiver Application URL: `https://leylinesync.com/cast-receiver`
   (must stay publicly reachable over HTTPS — it is: the page is unauthenticated;
   the board itself is protected by the per-session spectator token).
4. Save → you get an **Application ID** (8 hex chars).
5. **Testing before publishing:** an unpublished receiver only works on cast
   devices whose **serial number** you add under "Cast Receiver Devices" in the
   console (device needs "send serial number to Google" enabled in the Google
   Home app, then reboot it). Once you **publish** the app, it works on every
   Chromecast.

## Wiring the App ID into the app

Paste the ID into `lib/game/cast.ts`:

```ts
export const CAST_APP_ID: string | null = 'ABCD1234'
```

That's the only code change. From then on:

- The 📺 button (lobby + board) uses the **native cast picker** in Chrome on
  desktop **and Android (incl. the installed PWA)**.
- On connect, the sender messages the receiver over the custom channel
  `urn:x-cast:com.leylinesync.board` with the tokenized board URL; the
  receiver (app/cast-receiver/page.tsx) fills the TV with that board.
- Browsers without Cast support fall back to the Presentation API (desktop)
  or hide the button (iOS) — the 🔗 copy-link and the TV room code remain the
  universal paths.

## How the pieces fit

| Piece | File | Role |
|---|---|---|
| Sender helpers | `lib/game/cast.ts` | loads the sender SDK, opens the picker, sends the board URL |
| Cast button | `components/board/CastShareControls.tsx` | prefers Cast SDK, falls back to Presentation API |
| Receiver page | `app/cast-receiver/page.tsx` | CAF receiver; accepts same-origin board URLs only; `disableIdleTimeout` so long games never blank the TV |
