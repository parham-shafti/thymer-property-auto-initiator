/**
 * Auto-Init From Ancestor — workspace-wide App Plugin
 * ---------------------------------------------------
 *
 * When you create a new record while viewing another record in the focused edit
 * panel, the new record's fields can be pre-filled from the record you were inside.
 *
 * Per-field configuration lives in each collection's own plugin.json, under:
 *
 *     "custom": {
 *         "autoInit": {
 *             "<fieldId>": {
 *                 "useAncestorSelf":  true,   // Option 1: link to ancestor record
 *                 "useAncestorValue": true    // Option 2: inherit ancestor's value
 *                                              //          from its field with the SAME LABEL
 *                                              //          (same collection: matches by field ID)
 *             }
 *         }
 *     }
 *
 * Both flags on = Option 3: try value first, fall back to linking the ancestor itself.
 *
 * Commands (open the Command Palette — Cmd/Ctrl-P):
 *   - "Auto-Init: show field IDs for this collection"
 *       Prints a tidy list of field IDs + labels AND a ready-to-paste autoInit
 *       scaffold (with "label": "..." on every entry) for the currently open
 *       collection. Only the config block ("custom": { ... },) is copied to
 *       the clipboard — paste it straight into plugin.json. The field reference
 *       table is shown on screen and in DevTools Console for your reference.
 *       Just delete fields you don't want and flip the flags you do.
 *   - "Auto-Init: toggle verbose logging"
 *       Turn on/off detailed console output if something misbehaves.
 */

class Plugin extends AppPlugin {

    onLoad() {
        this._ancestorGuid = null;          // the "active record I'm inside" we'll use as ancestor
        this._ancestorTouchedAt = 0;        // for staleness guard
        this._verbose = false;              // set true via command palette if debugging
        this._STALE_MS = 30 * 1000;         // remembered ancestor expires after 30s of inactivity

        this._log('loaded');

        // 1) Track the "record I'm inside" — only when an edit panel is focused and has a record.
        try {
            this.events.on('panel.navigated', (ev) => this._rememberFromPanel(ev.panel, 'navigated'));
            this.events.on('panel.focused',   (ev) => this._rememberFromPanel(ev.panel, 'focused'));
        } catch (e) { console.error('[auto-init] failed to hook panel events:', e); }

        // Prime from whatever panel is already active at load time.
        try { this._rememberFromPanel(this.ui.getActivePanel(), 'init'); } catch (e) {}

        // 2) On record creation anywhere in the workspace, apply per-collection rules.
        this.events.on('record.created', (ev) => this._onRecordCreated(ev));

        // 3) Command palette: print field IDs for the open collection.
        this.ui.addCommandPaletteCommand({
            label: "Auto-Init: show field IDs for this collection",
            icon: "ti-list",
            onSelected: () => this._showFieldIds()
        });

        // 4) Command palette: toggle verbose logging.
        this.ui.addCommandPaletteCommand({
            label: "Auto-Init: toggle verbose logging",
            icon: "ti-bug",
            onSelected: () => {
                this._verbose = !this._verbose;
                this._toast(
                    this._verbose ? 'Auto-Init: verbose logging ON' : 'Auto-Init: verbose logging OFF',
                    this._verbose ? 'Open DevTools (F12) → Console to watch the plugin.' : null
                );
            }
        });
    }

    // -------------------- Ancestor tracking --------------------

    _rememberFromPanel(panel, why) {
        if (!panel) return;
        // Only consider real record editors — not collection overviews, sidebars, etc.
        if (panel.getType && panel.getType() !== 'edit_panel') return;
        if (panel.isSidebar && panel.isSidebar()) return;

        const rec = panel.getActiveRecord && panel.getActiveRecord();
        if (!rec) return;

        this._ancestorGuid = rec.guid;
        this._ancestorTouchedAt = Date.now();

        // Also record the ancestor's collection from the panel, so we can look up its
        // config later without having to scan.
        try {
            const coll = panel.getActiveCollection && panel.getActiveCollection();
            this._ancestorCollectionGuid = coll ? (coll.guid || (coll.getGuid && coll.getGuid())) : null;
            if (coll && this._collectionsByGuid) {
                this._collectionsByGuid.set(this._ancestorCollectionGuid, coll);
            } else if (coll) {
                this._collectionsByGuid = new Map([[this._ancestorCollectionGuid, coll]]);
            }
        } catch (e) { this._ancestorCollectionGuid = null; }

        this._log('ancestor remembered via', why, '=>', rec.guid,
                  rec.getName ? '(' + rec.getName() + ')' : '',
                  'coll=', this._ancestorCollectionGuid);
    }

    _resolveAncestor(newGuid) {
        // Prefer the cached "record I'm inside."
        if (this._ancestorGuid && this._ancestorGuid !== newGuid) {
            if (Date.now() - this._ancestorTouchedAt <= this._STALE_MS) {
                return this._ancestorGuid;
            }
            this._log('cached ancestor is stale; ignoring');
        }

        // Fallback: scan panels for an active, focused edit_panel that isn't the new record.
        // (Helpful if the very first user action is create-from-inside, before we've seen a panel event.)
        const panels = this.ui.getPanels ? this.ui.getPanels() : [];
        for (const p of panels) {
            if (p.getType && p.getType() !== 'edit_panel') continue;
            const ar = p.getActiveRecord && p.getActiveRecord();
            if (ar && ar.guid !== newGuid) return ar.guid;
        }
        return null;
    }

    // -------------------- Creation handler --------------------

    _onRecordCreated(ev) {
        if (!ev || !ev.source || !ev.source.isLocal) return;   // don't react to sync-ins
        const newGuid = ev.recordGuid;
        if (!newGuid) return;

        // Capture the NEW record's collection directly from the event — we can't
        // reverse-lookup the collection from a PluginRecord post-hoc.
        let newCollection = null;
        try {
            if (ev.getCollection) newCollection = ev.getCollection();
        } catch (e) {}
        const newCollectionGuid = ev.collectionGuid || (newCollection && newCollection.guid) || null;

        const ancestorGuid = this._resolveAncestor(newGuid);
        if (!ancestorGuid) {
            this._log('no ancestor for new record', newGuid, '— skipping');
            return;
        }
        if (ancestorGuid === newGuid) return;

        this._log('schedule apply: new=' + newGuid + ' ancestor=' + ancestorGuid +
                  ' newColl=' + newCollectionGuid);
        this._applyWithRetry(newGuid, ancestorGuid, newCollection, newCollectionGuid, 0);
    }

    _applyWithRetry(newGuid, ancestorGuid, newCollection, newCollectionGuid, attempt) {
        const MAX_ATTEMPTS = 20;   // ~1 second total
        const DELAY_MS = 50;

        const newRecord = this.data.getRecord(newGuid);
        const ancestor  = this.data.getRecord(ancestorGuid);

        if (!newRecord || !ancestor) {
            if (attempt >= MAX_ATTEMPTS) {
                this._log('gave up waiting for records; new=', !!newRecord, 'ancestor=', !!ancestor);
                return;
            }
            setTimeout(() => this._applyWithRetry(newGuid, ancestorGuid, newCollection, newCollectionGuid, attempt + 1), DELAY_MS);
            return;
        }

        // Resolve the new record's collection. Prefer the event-supplied one; fall back to
        // the async getAllCollections() lookup if needed.
        this._withCollection(newCollection, newCollectionGuid, (newColl) => {
            if (!newColl) { this._log('no collection for new record; skipping'); return; }
            this._applyWithCollections(newRecord, ancestor, newColl);
        });
    }

    /**
     * Resolve a PluginCollectionAPI given either the object itself, or a guid.
     * Results are cached on the plugin instance to avoid repeated async work.
     */
    _withCollection(maybeColl, guid, cb) {
        if (maybeColl) return cb(maybeColl);
        if (!guid) return cb(null);

        // Serve from cache if present.
        if (this._collectionsByGuid && this._collectionsByGuid.has(guid)) {
            return cb(this._collectionsByGuid.get(guid));
        }

        // Populate (or refresh) the cache.
        try {
            Promise.resolve(this.data.getAllCollections()).then((list) => {
                const map = new Map();
                for (const c of (list || [])) {
                    const g = c && (c.guid || (c.getGuid && c.getGuid()));
                    if (g) map.set(g, c);
                }
                this._collectionsByGuid = map;
                cb(map.get(guid) || null);
            }).catch((err) => {
                console.error('[auto-init] getAllCollections failed:', err);
                cb(null);
            });
        } catch (e) {
            console.error('[auto-init] _withCollection error:', e);
            cb(null);
        }
    }

    _applyWithCollections(newRecord, ancestor, newColl) {
        const newConfig = newColl.getConfiguration ? newColl.getConfiguration() : null;
        if (!newConfig) { this._log('no config for new record collection; skipping'); return; }
        const autoInit = (newConfig.custom && newConfig.custom.autoInit) || {};
        if (!autoInit || Object.keys(autoInit).length === 0) {
            this._log('no autoInit block on new record collection; skipping');
            return;
        }

        // Ancestor's collection: find it via the cache we may have populated above,
        // or scan getAllCollections() if not. We do this synchronously against the cache
        // since by this point _withCollection has likely populated it; if not, we proceed
        // without ancestor-config and Option 2 will no-op for cross-collection cases.
        const ancestorColl = this._findCollectionForRecord(ancestor);
        const ancestorConfig = ancestorColl && ancestorColl.getConfiguration
            ? ancestorColl.getConfiguration() : null;
        const sameCollection = ancestorColl && newColl && ancestorColl.guid === newColl.guid;

        // Build label -> field on the ancestor side for cross-collection matching.
        const ancestorFieldsByLabel = new Map();
        if (ancestorConfig && Array.isArray(ancestorConfig.fields)) {
            for (const af of ancestorConfig.fields) {
                if (!af.active) continue;
                if (!af.label) continue;
                const key = af.label.trim().toLowerCase();
                if (!ancestorFieldsByLabel.has(key)) ancestorFieldsByLabel.set(key, af);
            }
        }

        const fieldById = new Map();
        for (const f of (newConfig.fields || [])) if (f.active) fieldById.set(f.id, f);

        const applied = [];
        if (this._verbose) console.group('[auto-init] applying to ' + newRecord.guid);

        const autoInitKeys = Object.keys(autoInit);
        for (let ki = 0; ki < autoInitKeys.length; ki++) {
            const fieldId = autoInitKeys[ki];
            const opts = autoInit[fieldId] || {};
            const field = fieldById.get(fieldId);
            if (!field) { this._log('  skip', fieldId, '(field not found)'); continue; }
            if (field.read_only) { this._log('  skip', fieldId, '(read-only)'); continue; }
            if (field.type === 'dynamic') { this._log('  skip', fieldId, '(dynamic)'); continue; }

            const childProp = newRecord.prop(fieldId);
            if (!childProp) { this._log('  skip', fieldId, '(no childProp)'); continue; }
            if (!this._isEmpty(childProp, field.type)) {
                this._log('  skip', fieldId, '(child already has value)');
                continue;
            }

            const useValue = !!opts.useAncestorValue;
            const useSelf  = !!opts.useAncestorSelf;
            if (!useValue && !useSelf) continue;

            let didApply = null;

            // --- Option 2 (and first half of Option 3): inherit value from ancestor's matching field
            if (useValue) {
                let ancestorField = null;

                if (sameCollection) {
                    // Same collection: try matching by field ID.
                    ancestorField = (ancestorConfig && Array.isArray(ancestorConfig.fields))
                        ? ancestorConfig.fields.find(f => f.id === fieldId && f.active)
                        : null;
                } else {
                    // Different collection: match by LABEL.
                    if (field.label) {
                        ancestorField = ancestorFieldsByLabel.get(field.label.trim().toLowerCase()) || null;
                    }
                }

                if (ancestorField && ancestorField.type === field.type) {
                    const srcProp = ancestor.prop(ancestorField.id);
                    if (srcProp && !this._isEmpty(srcProp, ancestorField.type)) {
                        // _copyValue itself honors the target's filter_colguid for record fields
                        // (filters out linked records that point to a disallowed collection).
                        this._copyValue(childProp, srcProp, field.type, field, field.filter_colguid || null);
                        didApply = 'ancestor-value';
                    }
                } else if (this._verbose) {
                    console.log('  (value) no matching ancestor field for', fieldId,
                                'label=', field.label, 'sameCollection=', sameCollection);
                }
            }

            // --- Option 1 (and fallback half of Option 3): link the ancestor record itself
            if (!didApply && useSelf && field.type === 'record') {
                const forceIgnore = !!opts.forceSelfIgnoreFilter;
                if (forceIgnore || this._linkAllowedByCollection(field, ancestorColl && ancestorColl.guid)) {
                    childProp.set(ancestor.guid);
                    didApply = forceIgnore && !this._linkAllowedByCollection(field, ancestorColl && ancestorColl.guid)
                        ? 'ancestor-self (filter bypassed)'
                        : 'ancestor-self';
                } else {
                    this._log('  (self) blocked: ancestor collection not allowed by filter_colguid on', fieldId,
                              '— set "forceSelfIgnoreFilter": true to bypass');
                }
            }

            const labelPart = opts.label ? ' "' + opts.label + '"' : '';
            this._log('  field', fieldId + labelPart, '(' + field.type + ')',
                      'useValue=' + useValue, 'useSelf=' + useSelf,
                      '=>', didApply || 'nothing');
            if (didApply) applied.push({ fieldId: fieldId, how: didApply });
        }

        if (this._verbose) {
            console.log('[auto-init] applied:', applied);
            console.groupEnd();
        }
    }

    // -------------------- Helpers --------------------

    /**
     * Best-effort: given a PluginRecord, find the collection that owns it by
     * scanning the cached collections map. Returns null if unknown.
     */
    _findCollectionForRecord(record) {
        if (!record || !record.guid) return null;
        const map = this._collectionsByGuid;
        if (!map) return null;
        for (const c of map.values()) {
            try {
                // getAllRecords() is a Promise on PluginCollectionAPI — skipping it
                // (too expensive per creation). Instead we rely on the creation event
                // having told us the NEW record's collection. For the ANCESTOR record
                // we use a simpler heuristic: the ancestor's collection is the one
                // we last saw it navigated in via a panel event.
            } catch (e) {}
        }
        // Ancestor panel capture (see _rememberFromPanel): we also store its collection.
        if (this._ancestorCollectionGuid && map.has(this._ancestorCollectionGuid)) {
            return map.get(this._ancestorCollectionGuid);
        }
        return null;
    }

    /** Checks filter_colguid against an ancestor collection guid (for Option 1). */
    _linkAllowedByCollection(field, ancestorCollectionGuid) {
        if (!field.filter_colguid) return true;
        if (!ancestorCollectionGuid) return true;
        return field.filter_colguid === ancestorCollectionGuid;
    }

    _isEmpty(prop, type) {
        if (type === 'file' || type === 'image' || type === 'banner') return prop.file() === null;
        if (type === 'datetime') return prop.date() === null;
        if (type === 'choice')   return prop.choice() === null;
        if (type === 'number')   return prop.number() === null;
        if (type === 'user')     return prop.user() === null;
        if (type === 'record')   return prop.linkedRecord() === null;
        return prop.text() === null;
    }

    /**
     * Copy a value from `source` prop to `target` prop, preserving multi-value semantics.
     * If the target field is multi-value (`field.many`), copy ALL values from source.
     * For record fields we additionally filter out linked records that violate the
     * target's filter_colguid (if any).
     */
    _copyValue(target, source, type, targetField, linkFilterGuid) {
        const many = !!(targetField && targetField.many);
        switch (type) {
            case 'number': {
                if (many && source.numbers) {
                    const arr = source.numbers();
                    if (arr && arr.length) target.set(arr);
                } else {
                    target.set(source.number());
                }
                break;
            }
            case 'choice': {
                const choices = source.selectedChoices();
                if (choices && choices.length) target.setChoice(choices);
                break;
            }
            case 'datetime': {
                if (many && source.datetimes) {
                    const arr = source.datetimes();
                    if (arr && arr.length) {
                        const values = [];
                        for (let i = 0; i < arr.length; i++) {
                            const v = arr[i] && arr[i].value ? arr[i].value() : null;
                            if (v) values.push(v);
                        }
                        if (values.length) target.set(values);
                    }
                } else {
                    const dt = source.datetime();
                    if (dt) target.set(dt.value());
                }
                break;
            }
            case 'user': {
                if (many && source.users) {
                    const arr = source.users();
                    if (arr && arr.length) {
                        const guids = [];
                        for (let i = 0; i < arr.length; i++) {
                            if (arr[i] && arr[i].guid) guids.push(arr[i].guid);
                        }
                        if (guids.length) target.set(guids);
                    }
                } else {
                    const u = source.user();
                    if (u) target.set(u.guid);
                }
                break;
            }
            case 'record': {
                const records = (many && source.linkedRecords) ? source.linkedRecords()
                                                              : (source.linkedRecord() ? [source.linkedRecord()] : []);
                if (!records || !records.length) break;
                const guids = [];
                for (let i = 0; i < records.length; i++) {
                    const r = records[i];
                    if (!r || !r.guid) continue;
                    // Honor the TARGET field's filter_colguid when linking records.
                    if (linkFilterGuid) {
                        const rc = this._collectionForRecord(r);
                        const rcGuid = rc && (rc.guid || (rc.getGuid && rc.getGuid()));
                        if (rcGuid && rcGuid !== linkFilterGuid) continue;
                    }
                    guids.push(r.guid);
                }
                if (!guids.length) break;
                if (many) {
                    target.set(guids);
                } else {
                    target.set(guids[0]);
                }
                break;
            }
            case 'file':
            case 'image':
            case 'banner': {
                const f = source.file();
                if (f) target.setFile(f);
                break;
            }
            default: {
                if (many && source.texts) {
                    const arr = source.texts();
                    if (arr && arr.length) target.set(arr);
                } else {
                    target.set(source.text());
                }
                break;
            }
        }
    }

    /** Try to resolve the collection that owns a record (used for filter_colguid checks). */
    _collectionForRecord(record) {
        if (!record) return null;
        try {
            if (record.getCollection) return record.getCollection();
        } catch (e) {}
        // Fall back to our cache via guid if the record exposes a collectionGuid
        const g = record.collectionGuid || (record.getCollectionGuid && record.getCollectionGuid());
        if (g && this._collectionsByGuid && this._collectionsByGuid.has(g)) {
            return this._collectionsByGuid.get(g);
        }
        return null;
    }

    // -------------------- Field-IDs helper --------------------

    _showFieldIds() {
        const panel = this.ui.getActivePanel();
        const coll = panel ? panel.getActiveCollection() : null;
        if (!coll) {
            this._toast('Open a collection first',
                'Navigate to any collection view, then run this command again.');
            return;
        }

        const cfg = coll.getConfiguration ? coll.getConfiguration() : null;
        if (!cfg) { this._toast('No configuration for this collection'); return; }

        const rows = [];
        rows.push('Collection: ' + (cfg.name || '(unnamed)'));
        rows.push('GUID: ' + (coll.guid || coll.getGuid && coll.getGuid()));
        rows.push('');
        rows.push('FIELD ID               TYPE        LABEL');
        rows.push('------------------     --------    ------------------------');

        for (const f of (cfg.fields || [])) {
            if (!f.active) continue;
            const id = String(f.id || '').padEnd(22);
            const ty = String(f.type || '').padEnd(11);
            rows.push(id + ' ' + ty + ' ' + (f.label || ''));
        }

        // --- Ready-to-paste scaffold (parser-safe JSON) ---
        const activeFields = [];
        for (const f of (cfg.fields || [])) {
            if (!f.active) continue;
            if (f.read_only) continue;
            if (f.type === 'dynamic') continue;
            activeFields.push(f);
        }

        // Leading-comma style so you can freely delete entries without creating
        // a trailing-comma JSON error. The first entry has no leading comma;
        // every subsequent entry starts with ", " — delete any entry except the
        // first and the JSON is still valid.
        const entryLines = [];
        for (let i = 0; i < activeFields.length; i++) {
            const f = activeFields[i];
            const isRecord = f.type === 'record';
            // Record fields get all three flags. `forceSelfIgnoreFilter` defaults
            // to false for safety — enable it per-field when you want the ancestor
            // link even if the field's picker filter restricts the collection.
            const flags = isRecord
                ? '"useAncestorValue": false, "useAncestorSelf": false, "forceSelfIgnoreFilter": false'
                : '"useAncestorValue": false';
            const labelJson = JSON.stringify(f.label || '');
            const prefix = (i === 0) ? '          ' : '        , ';
            entryLines.push(
                prefix + '"' + f.id + '": { "label": ' + labelJson + ', ' + flags + ' }'
            );
        }

        rows.push('');
        rows.push('=========================================================');
        rows.push('Replace the entire "custom": { ... } block in this');
        rows.push('collection\'s plugin.json with the block below.');
        rows.push('Then flip any flags you want to use from false to true.');
        rows.push('You can delete any field entries you don\'t need — the commas');
        rows.push('sit at the START of each line (except the first), so deleting');
        rows.push('middle or last entries leaves valid JSON. If you delete the');
        rows.push('FIRST entry, remove the "," from what becomes the new first line.');
        rows.push('=========================================================');
        rows.push('');
        // Build the JSON-only block (what actually goes into plugin.json).
        // This is what we put on the clipboard — so users can paste directly
        // without having to manually select it out of the larger output.
        const jsonRows = [];
        jsonRows.push('"custom": {');
        jsonRows.push('    "autoInit": {');
        for (const line of entryLines) jsonRows.push(line);
        jsonRows.push('    }');
        jsonRows.push('},');
        const jsonOnly = jsonRows.join('\n');

        // Append the JSON block to the on-screen/console output for reference.
        for (const r of jsonRows) rows.push(r);

        const text = rows.join('\n');
        console.log('%c[auto-init] field IDs:\n', 'color:#0a0;font-weight:bold');
        console.log(text);

        // Drop ONLY the JSON block on the clipboard so a single paste into
        // plugin.json works without manual trimming.
        try {
            if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(jsonOnly);
                this._toast('Config block copied to clipboard',
                    'Paste it into the collection\'s plugin.json. Field reference is in DevTools → Console (F12).');
                return;
            }
        } catch (e) {}
        this._toast('Field IDs printed in DevTools Console',
            'Press F12 and open the Console tab to view them.');
    }

    // -------------------- Tiny utils --------------------

    _log() {
        if (!this._verbose) return;
        const args = ['[auto-init]'];
        for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
        console.log.apply(console, args);
    }

    _toast(title, message) {
        try {
            this.ui.addToaster({ title: title, message: message, dismissible: true, autoDestroyTime: 6000 });
        } catch (e) { console.log('[auto-init]', title, message || ''); }
    }
}
