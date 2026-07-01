# Installation guide

A step-by-step walkthrough for installing the plugin in Thymer. For the short version, see the main [README](../README.md#installation).

## Option A: Plugins Manager (recommended)

1. In Thymer, open **Plugins Manager → Install Plugin**.
2. Paste the repository URL: `https://github.com/parham-shafti/thymer-property-auto-initiator`
3. Confirm. Thymer fetches `plugin.js` and `plugin.json` from the repository root.
4. **Hard-reload Thymer** (macOS: `Cmd + Shift + R`, Windows/Linux: `Ctrl + Shift + R`). This is required so the plugin can register its event listeners.

Future updates can be pulled with the refresh button on the plugin card.

## Option B: manual install

### 1. Open plugin settings

Go to **Plugin Settings → App Plugins → New Plugin**.

### 2. Set the metadata

Paste the contents of [`plugin.json`](../plugin.json) into the plugin's metadata field.

### 3. Paste the code

Open the plugin's **Custom Code** editor and paste the entire contents of [`plugin.js`](../plugin.js). It is a single `class Plugin extends AppPlugin { ... }` block. Do not add `export` or `import` statements; Thymer's parser rejects them.

### 4. Save and hard-reload

Click **Save**, then **hard-reload Thymer** (`Cmd/Ctrl + Shift + R`).

## Configure it

The plugin does nothing until you tell it which fields on which collections should inherit from the ancestor.

1. Open the Command Palette (`Cmd/Ctrl + P`) and run **"Auto-Init: Settings"**.
2. On the **Collections** tab, add a collection and toggle **Value** / **Self** / **Ignore filter** per field.
3. On the **Blocklist** tab, add any collection you want left untouched (for example your Journal).
4. Click **Save**.

See the main README for [configuration details](../README.md#configuring-it).
