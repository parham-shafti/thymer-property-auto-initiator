# Thymer Property Auto-Initiator

A workspace-wide [Thymer](https://thymer.com) App Plugin that **auto-populates fields on newly created records** based on the record you're currently viewing.

Create a new child record while you're inside a parent record, and the plugin will pre-fill fields on the child from the parent — either by **inheriting a value** (e.g. a tag, a date, a linked record) or by **linking to the parent itself** (the classic "this child belongs to that parent" pattern).

Works within a single collection *and* across collections. Fully per-field configurable via each collection's `plugin.json`.

---

## Table of contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Per-collection configuration](#per-collection-configuration)
  - [Generating a config scaffold](#generating-a-config-scaffold)
  - [Configuration reference](#configuration-reference)
  - [Same-collection vs. cross-collection matching](#same-collection-vs-cross-collection-matching)
- [Examples](#examples)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)
- [Requirements](#requirements)
- [Contributing](#contributing)
- [License](#license)

---

## What it does

Two kinds of auto-initialization, each toggleable **per field**:

| Option | Flag | What it does |
|---|---|---|
| **Option 1 — Link ancestor itself** | `useAncestorSelf` | Sets the child field to the ancestor record. Only works for record-type fields. |
| **Option 2 — Inherit ancestor value** | `useAncestorValue` | Copies the value of the ancestor's matching field into the child. Works for all field types. |
| **Option 3 — Both** | both set to `true` | Tries Option 2 first; if the ancestor has no value there, falls back to Option 1. |

Both flags are **independent** — enable whichever combination you need per field.

### Examples of each

- **Option 1**: In an Actions collection, auto-set `Serves` to the Book you were viewing when you added the Action.
- **Option 2**: Inherit the parent's `Garden` tag, `Priority`, `Owner`, or `Due Date` onto the new child.
- **Option 3**: `Parent Task` field — if parent already has one, use it; otherwise, link the parent itself.

---

## How it works

1. The plugin watches `panel.navigated` and `panel.focused` events to remember which record you're currently viewing in the focused edit panel. This is your **ancestor**.
2. When `record.created` fires anywhere in the workspace (from your own action — sync-ins are ignored), the plugin reads the new record's collection's `custom.autoInit` block.
3. For each configured field, it checks the flags and applies whichever inheritance rule you've set.
4. The ancestor memory has a **30-second staleness guard** — if you haven't touched any record panel in 30 seconds, the plugin won't incorrectly attribute a new record to a stale ancestor.
5. Multi-value fields (records, choices, users, etc.) inherit *all* values, not just the first.

---

## Installation

### 1. Install the App Plugin

1. In Thymer, go to **Plugin Settings → App Plugins → New Plugin**.
2. Set the plugin's metadata by pasting the contents of [`plugin/plugin.json`](plugin/plugin.json) (name, icon, description).
3. Open the plugin's **Custom Code** editor and paste the entire contents of [`plugin/plugin.js`](plugin/plugin.js).
4. **Save**.
5. **Hard-reload Thymer** (Cmd+Shift+R / Ctrl+Shift+R) — required for the plugin to register its event listeners.

The plugin is now active workspace-wide. No per-collection installation is needed — you just configure each collection where you want auto-init to apply.

### 2. Verify

Open DevTools (F12 → Console), then run **"Auto-Init: toggle verbose logging"** from the command palette. You should see a toast confirming verbose mode is on. Navigate into a record and you'll see log lines like:

```
[auto-init] ancestor remembered via navigated => <guid> (<record name>) coll=<collection guid>
```

If you see nothing, check that the plugin saved without errors and that you hard-reloaded.

---

## Per-collection configuration

Each collection where you want auto-init on new records gets its own `custom.autoInit` block in its `plugin.json`. The plugin reads this config live — no reload required after editing (though a manual refresh doesn't hurt if a collection was in the middle of something).

### Generating a config scaffold

The plugin has a command palette helper that generates a ready-to-paste scaffold **with labels** for the current collection.

1. Open any collection in Thymer (any view is fine).
2. Open the command palette (Cmd/Ctrl+P).
3. Run **"Auto-Init: show field IDs for this collection"**.
4. The scaffold is copied to your clipboard and printed to the console.

The output looks like this (leading-comma format — safely edit or delete any entry without JSON errors):

```jsonc
"custom": {
    "autoInit": {
          "FC8G2Z06T66VTWX": { "label": "Garden",  "useAncestorValue": false }
        , "F8KG631NRHN3APW": { "label": "Action Term", "useAncestorValue": false }
        , "FE01P4Y48ZEN149": { "label": "Related People", "useAncestorValue": false, "useAncestorSelf": false, "forceSelfIgnoreFilter": false }
        , "FN9J4S6MMQS6CED": { "label": "Agents", "useAncestorValue": false, "useAncestorSelf": false, "forceSelfIgnoreFilter": false }
    }
},
```

Then:

- Flip the flags you want to use from `false` to `true`.
- Delete entries for fields you don't want auto-initialized.
- Paste into the collection's `plugin.json`, replacing the existing `"custom": { ... }` block.

### Configuration reference

Each field entry supports these keys:

| Key | Type | Applies to | Default | Description |
|---|---|---|---|---|
| `label` | string | all fields | `""` | Human-readable label for the field (ignored by the plugin, only there to help you remember which ID is which). |
| `useAncestorValue` | bool | all fields | `false` | If `true`, inherit the ancestor's value from its matching field. |
| `useAncestorSelf` | bool | record fields only | `false` | If `true`, link the ancestor record itself into this field. |
| `forceSelfIgnoreFilter` | bool | record fields only | `false` | If `true`, bypass the field's `filter_colguid` (picker "Filter by collection" setting) when writing the ancestor link. **Warning:** if the field's filter wouldn't normally allow the ancestor, Thymer may render the linked record as `(Other)` — use only when you understand the tradeoff. |

### Same-collection vs. cross-collection matching

The plugin handles both cases automatically:

- **Same collection** (child created inside an ancestor from the same collection — e.g. sub-tasks in a Tasks collection): the ancestor's field is found by matching **field ID**.
- **Cross collection** (child and ancestor live in different collections — e.g. an Action inside a Book): the ancestor's field is found by matching **field label** (case-insensitive, trimmed) **and** field type.

For Option 2 (`useAncestorValue`) to work cross-collection, the ancestor must have a field with the **same label and same type** as the child's field. Field IDs don't need to match.

For Option 1 (`useAncestorSelf`) to work cross-collection, the child's record field must either have no picker filter (`Link to All Records`) or explicitly allow the ancestor's collection. Otherwise:

- Without `forceSelfIgnoreFilter`: the plugin refuses to write (safe default) and logs a skip reason.
- With `forceSelfIgnoreFilter: true`: the plugin writes the link anyway. Thymer may display it as `(Other)` because the field's UI still enforces the filter on render.

**Recommendation:** when you want cross-collection "link to ancestor," widen the child field's picker filter in its collection settings. It's the cleanest fix and avoids the `(Other)` display.

---

## Examples

See the [`examples/`](examples) directory for working `plugin.json` fragments, including:

- [`examples/same-collection-subtasks.json`](examples/same-collection-subtasks.json) — sub-tasks inheriting parent metadata
- [`examples/cross-collection-books-actions.json`](examples/cross-collection-books-actions.json) — Actions inheriting from a parent Book

---

## Commands

The plugin registers two commands in Thymer's command palette:

- **Auto-Init: show field IDs for this collection** — prints a list of field IDs + labels AND a ready-to-paste `autoInit` scaffold for the current collection. Copied to clipboard.
- **Auto-Init: toggle verbose logging** — turns on/off detailed console logging. Useful when diagnosing why a field wasn't populated.

---

## Troubleshooting

### Nothing happens when I create a record inside another record

1. Confirm the plugin is loaded: enable verbose logging, open DevTools Console. You should see `[auto-init] loaded` on Thymer startup.
2. Check that the child collection has a `custom.autoInit` block in its `plugin.json` and that the field IDs are correct.
3. Confirm the flags are `true`, not `false` — the scaffold generates everything as `false` by default.

### A record field is populated with `(Other)` instead of the parent's name

The child field's **Filter by collection** setting restricts it to a collection different from the ancestor's. Either:

- Change the field's filter to **"Link to All Records"** (or explicitly allow the ancestor's collection), or
- Set `"forceSelfIgnoreFilter": true` on that field if you accept the `(Other)` display.

### Cross-collection value inheritance isn't working

- Make sure the ancestor has a field with the **exact same label** (case-insensitive, trimmed) and **same type** as the child's field.
- If field types differ (e.g. one is `choice`, the other is `hashtag`), inheritance won't trigger — there's no safe cross-type conversion.

### Debugging

Enable verbose logging and recreate the scenario. The log will tell you exactly what the plugin decided, including:

- Which ancestor was remembered and when
- For each configured field: whether `useAncestorValue` and `useAncestorSelf` were set, what the plugin tried, and whether it succeeded, was skipped (and why), or was blocked by a filter

---

## Requirements

- Thymer with App Plugin support
- A modern Chromium-based browser (Thymer's embedded browser or Chrome/Comet/Edge/Arc)

---

## Contributing

This is an early release. Issues and PRs welcome — especially:

- Reports of edge cases where inheritance doesn't behave as expected
- Additional field-type support (anything the plugin currently skips)
- UX improvements to the scaffold generator

Please include a minimal reproduction (collection configs, the ancestor/child pair you created, and verbose log output) when filing an issue.

---

## License

[MIT](LICENSE) — use it, modify it, share it, ship it.
