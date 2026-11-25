# scripts

Repo tooling.

- `sync-brand.mjs` reads the product name from root `brand.json` and synchronizes
  application text, native packaging, runtime prompts, release scripts and docs.
  Run `pnpm brand:sync` after editing the name, or `pnpm brand:check` to check
  without writing. Development and build commands run the sync automatically.
  Existing storage paths, Rust crate names, bundle identifiers and lines marked
  `brand:keep` stay stable so a rename does not invalidate installed data.

- `release/` — packaging and release scripts (Tauri build matrix, signing/notarization
  helpers, GitHub Release upload, `latest.json` generation).
- `dev/` — local development helpers (bootstrap, run the app, seed the demo workspace).
