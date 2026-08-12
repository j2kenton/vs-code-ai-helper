# Mobile app deploy packaging

Part 11 packaging reference for `apps/mobile`. Building/submitting requires
real Apple/Google developer accounts and an Expo/EAS project, so this is the
config and procedure, not an executed release.

## Web

`pnpm --filter @ensemble/mobile build:web` runs `expo export --platform web`
and produces a static bundle in `dist/` (Metro bundler, `web.output: "single"`
per `app.json`) that can be served by any static host or CDN. There is no
server-side rendering requirement — the control-plane API (Part 3/5) is a
separate deployment.

## iOS / Android (EAS Build)

`eas.json` defines three build profiles:
- `development` — dev-client build, internal distribution, points at the dev
  control plane.
- `preview` — internal distribution for QA, points at the staging control
  plane, uses the `preview` update channel.
- `production` — store-distributable build, points at the production control
  plane, auto-increments the build number.

Run with `pnpm --filter @ensemble/mobile build:ios` / `build:android` (wraps
`eas build`). These require `eas login` against an Expo account with access to
the `dev.ensemble.commandcenter` project, plus platform credentials (Apple
Developer Program membership + App Store Connect API key for iOS; a Google
Play service account JSON for Android) supplied interactively or via
`eas credentials`.

## Store submission

`eas.json`'s `submit.production` profile is the target for
`pnpm --filter @ensemble/mobile submit:ios` / `submit:android`
(wraps `eas submit`). The `appleId` / `ascAppId` / `appleTeamId` fields and the
`google-service-account.json` path are placeholders — real values are
account-specific secrets and are supplied locally or via CI secrets, never
committed.

## What's out of scope here

Actually cutting a release (App Store Connect listing, Play Console listing,
production control-plane URL, real Apple/Google credentials) is a one-time
account-setup task for whoever owns app store presence, not something this
repo can complete on its own. This document plus `eas.json` and the
`build:*`/`submit:*` scripts are the reusable packaging path once those
accounts exist.
