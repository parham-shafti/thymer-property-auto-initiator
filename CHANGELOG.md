# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-04-22

### Changed
- **Repo layout:** moved `plugin/plugin.js` and `plugin/plugin.json` to the repository root so Thymer's Plugins Manager can install directly from the GitHub URL. Thymer's manager expects `plugin.js` and `plugin.json` at the repo root — the previous `plugin/` subfolder layout caused "No config file (.json) found" errors on install.
- Updated README with an **Option A — via Thymer's Plugins Manager** installation path (paste the repo URL, done) alongside the existing copy-paste method.
- Updated `docs/INSTALL.md` path references.

## [0.1.1] — 2026-04-22

### Changed
- **"Auto-Init: show field IDs for this collection"** now copies only the `"custom": { ... },` config block to the clipboard, so users can paste it directly into a collection's `plugin.json` without manually selecting it out of the larger output. The field reference table and scaffold instructions are still shown on screen and in the DevTools Console, but no longer pollute the clipboard paste.
- Updated toast wording to reflect the clipboard contents ("Config block copied to clipboard").

## [0.1.0] — 2026-04-22

Initial public release.

### Added
- Workspace-wide Thymer App Plugin that pre-fills fields on newly created records based on the ancestor record you're currently viewing.
- Two independent per-field flags (`useAncestorValue`, `useAncestorSelf`) that combine into three working modes.
- Same-collection matching by field ID; cross-collection matching by field label (case-insensitive, trimmed) and field type.
- Multi-value support for record, choice, user, datetime, and text fields — all values from the ancestor are inherited, not just the first.
- `forceSelfIgnoreFilter` per-field escape hatch for writing ancestor links past a field's `filter_colguid`.
- 30-second staleness guard on the remembered ancestor, plus panel-based detection (only records focused in `edit_panel` are considered).
- Respect for `ev.source.isLocal` — the plugin does not react to records synced in from other devices.
- Command palette entry **"Auto-Init: show field IDs for this collection"** — prints a table of field IDs/labels and a ready-to-paste scaffold with leading-comma formatting so entries can be deleted without JSON errors.
- Command palette entry **"Auto-Init: toggle verbose logging"** for debugging.

### Notes
- This is a first public release. Please report edge cases and unexpected behavior via GitHub Issues, including a minimal reproduction and verbose log output.
