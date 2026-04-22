# Installation guide

A detailed walkthrough for installing the plugin in Thymer. For the short version, see the main [README](../README.md#installation).

## 1. Open Plugin Settings

In Thymer, go to **Settings → Plugins → App Plugins**. Click **"New plugin"** (or the equivalent button in your version).

## 2. Configure metadata

Paste the following JSON into the plugin's metadata / manifest field (or fill in the UI equivalents):

```json
{
    "ver": 1,
    "name": "Auto-Init From Ancestor",
    "icon": "ti-wand",
    "description": "Workspace-wide: when you create a record while viewing another record, pre-fill fields on the new record based on the ancestor."
}
```

The full file is at [`plugin/plugin.json`](../plugin/plugin.json).

## 3. Paste the plugin code

Open the plugin's **Custom Code** editor. Paste the entire contents of [`plugin/plugin.js`](../plugin/plugin.js) into it.

If Thymer's editor reports a syntax error, make sure you copied the **entire** file — the plugin is a single `class Plugin extends AppPlugin { ... }` block. Do not add `export` or `import` statements; Thymer's parser rejects them.

## 4. Save and hard-reload

Click **Save**. The editor should accept the code without errors.

Now **hard-reload Thymer**:

- macOS: `Cmd + Shift + R`
- Windows/Linux: `Ctrl + Shift + R`

Hard reload is required — a normal reload may not re-register the plugin's event listeners.

## 5. Verify

1. Open DevTools → Console (F12 → Console).
2. Open the command palette (Cmd/Ctrl+P) and run **"Auto-Init: toggle verbose logging"**. You should see a toast confirming verbose mode is on.
3. Navigate into any record. The console should show something like:
   ```
   [auto-init] ancestor remembered via navigated => <guid> (<record name>) coll=<collection guid>
   ```

If you see this, the plugin is running and tracking panel navigation correctly.

## 6. Configure per-collection rules

The plugin does nothing until you tell it which fields on which collections should be auto-initialized. Open any collection, run **"Auto-Init: show field IDs for this collection"**, and follow the on-screen scaffold instructions.

See the main README for [configuration details](../README.md#per-collection-configuration).
