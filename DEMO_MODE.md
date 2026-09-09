# Demo mode

This branch adds a third playlist type, `demo`, alongside `xtream` and `m3u`.

Selecting **"Explore with a demo catalogue"** on the login screen seeds a
synthetic catalogue with neutral placeholder names and no provider at all:

| | |
| --- | --- |
| Live TV | 6 categories, 60 channels ("Category 1", "Channel 1"), 20 with catch-up |
| Movies | 5 categories, 90 titles ("Movie 1") |
| Series | 4 categories, 40 titles ("Series 1"), 3 seasons of 10 episodes each |
| EPG | A 45-minute programme grid across 30 channels, spanning now ±several hours |
| Favourites | Seeded across live, movies and series |
| Continue watching | Five part-watched items, so the Home rail is populated |

## Why it exists

The app is useless without a provider, which makes it impossible to screenshot,
demo or manually test without pointing it at a live subscription. A real
provider's catalogue also isn't something that belongs in a public repository.

The seed writes through the **same bulk writers the real sync uses**
(`replaceCategories`, `replaceLiveStreams`, `replaceVodStreams`,
`replaceSeries`, `saveSeriesInfo`, `replaceEpgForChannel`). Nothing is mocked at
the component level — every screen is reading genuine SQLite rows, so the demo
exercises the real code path rather than a parallel one.

## What changed

| File | Change |
| --- | --- |
| `services/demoData.js` | New. Generates the placeholder catalogue. |
| `services/catalogueSync.js` | `runDemoSync()` plus a branch in `runFullSync`. |
| `context/AuthContext.js` | `demo` playlists carry no credentials, like `m3u`. |
| `screens/LoginScreen.js` | Demo button, passed to `AuthForm`'s existing `footer` prop. |

## Playback

Live channels and movies point at public, freely redistributable test assets
(Big Buck Bunny, Blender Foundation, CC-BY) declared at the top of
`services/demoData.js`. Swap `DEMO_LIVE_URL` / `DEMO_VOD_URL` if either stops
resolving.

Episode playback is not wired up: the `episodes` table has no `direct_url`
column, since only Xtream provides series and it builds URLs from credentials.
Series browsing works fully; pressing play on an episode does not.

## Artwork

`USE_REMOTE_POSTERS` in `services/demoData.js` defaults to `false`, so the UI
falls back to its own placeholder tiles. That keeps the demo entirely offline
with no third-party images in screenshots. Set it to `true` for coloured tiles
carrying each item's name.

## Running it

```bash
npx expo run:android -d
```

Then tap **Explore with a demo catalogue** and let the sync finish. To get back
to a real provider, sign out from the Profile tab, or add a normal playlist from
the Playlists tab and make it active.

This branch is for screenshots and manual testing. It is not intended to merge
to `main` as-is.
