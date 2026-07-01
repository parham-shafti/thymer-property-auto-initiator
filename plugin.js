/**
 * Auto-Init From Ancestor — workspace-wide App Plugin
 * ---------------------------------------------------
 *
 * When you create a new record while viewing another record in the focused edit
 * panel, the new record's fields can be pre-filled from the record you were inside.
 *
 * Configuration lives CENTRALLY in this plugin's own config (custom.autoInit),
 * keyed by collection GUID. You edit it through a visual settings panel — no more
 * hand-editing each collection's plugin.json.
 *
 *     custom.autoInit = {
 *         version: 2,
 *         collections: {
 *             "<collectionGuid>": {
 *                 name: "Companies",
 *                 fields: {
 *                     "<fieldId>": {
 *                         label: "Serves",
 *                         useAncestorValue: false,   // inherit ancestor's value (matching field)
 *                         useAncestorSelf:  true,    // link the ancestor record itself (record fields)
 *                         forceSelfIgnoreFilter: false
 *                     }
 *                 }
 *             }
 *         },
 *         blocklist: [ "<collectionGuid>" ]   // collections that are NEVER auto-initialised
 *     }
 *
 * Both value+self on a field = try value first, fall back to linking the ancestor.
 *
 * Command (Command Palette — Cmd/Ctrl-P):
 *   - "Auto-Init: Settings" — open the visual configuration panel.
 *
 * On first load after upgrading from the old per-collection format, the plugin
 * AUTO-MIGRATES: it imports every collection's old `custom.autoInit` block into the
 * central config, then cleans the old blocks out of those collections.
 */

class Plugin extends AppPlugin {

    onLoad() {
        this._ancestorGuid = null;          // the "active record I'm inside" we'll use as ancestor
        this._ancestorTouchedAt = 0;        // for staleness guard
        this._ancestorCollectionGuid = null;
        this._collectionsByGuid = new Map(); // guid -> PluginCollectionAPI (runtime cache)
        this._verbose = false;              // set true via command palette if debugging
        this._STALE_MS = 30 * 1000;         // remembered ancestor expires after 30s of inactivity
        this._settingsEl = null;            // settings modal root, when open

        this._log('loaded');

        // 1) Track the "record I'm inside" — only when an edit panel is focused and has a record.
        try {
            this.events.on('panel.navigated', (ev) => this._rememberFromPanel(ev.panel, 'navigated'));
            this.events.on('panel.focused',   (ev) => this._rememberFromPanel(ev.panel, 'focused'));
        } catch (e) { console.error('[auto-init] failed to hook panel events:', e); }

        // Prime from whatever panel is already active at load time.
        try { this._rememberFromPanel(this.ui.getActivePanel(), 'init'); } catch (e) {}

        // 2) On record creation anywhere in the workspace, apply the central rules.
        this.events.on('record.created', (ev) => this._onRecordCreated(ev));

        // 3) Command palette: open the visual settings panel.
        this.ui.addCommandPaletteCommand({
            label: "Auto-Init: Settings",
            icon: "ti-wand",
            onSelected: () => this.openSettings()
        });

        // 4) One-time migration from the old per-collection format. Guarded so it
        //    only does real work once; cheap no-op on every subsequent load.
        //    (Verbose logging is kept internally — this._verbose / _log — for
        //    troubleshooting, but is intentionally not exposed in the palette.)
        this._maybeMigrate();
    }

    // -------------------- Central config --------------------

    /** Read this plugin's own central config, normalised. Synchronous, in-memory. */
    _readConfig() {
        let custom = {};
        try { custom = (this.getConfiguration() && this.getConfiguration().custom) || {}; } catch (e) {}
        const ai = (custom && custom.autoInit) || {};
        return {
            version: ai.version || 0,
            collections: (ai.collections && typeof ai.collections === 'object') ? ai.collections : {},
            blocklist: Array.isArray(ai.blocklist) ? ai.blocklist : [],
            cleanupPending: Array.isArray(ai.cleanupPending) ? ai.cleanupPending : []
        };
    }

    /** Persist the central config on this plugin. NOTE: reloads the plugin. */
    async _saveConfig(next) {
        const all = await this.data.getAllGlobalPlugins();
        const self = (all || []).find((g) =>
            (g.guid && g.guid === this.getGuid()) ||
            (g.getGuid && g.getGuid() === this.getGuid()));
        if (!self) throw new Error('plugin handle not found');
        const conf = this.getConfiguration() || {};
        conf.custom = conf.custom || {};
        conf.custom.autoInit = next;
        await self.saveConfiguration(conf);
    }

    // -------------------- Migration (old per-collection -> central) --------------------

    async _maybeMigrate() {
        let central;
        try { central = this._readConfig(); } catch (e) { return; }

        try {
            if (central.version >= 2) {
                // Already imported. Finish any pending cleanup of old blocks.
                if (central.cleanupPending && central.cleanupPending.length) {
                    await this._runCleanup(central);
                }
                return;
            }

            // --- Import phase: pull every collection's old custom.autoInit into central. ---
            const list = (await this.data.getAllCollections()) || [];
            const collections = central.collections || {};
            const cleanup = [];

            for (const c of list) {
                const guid = c && (c.guid || (c.getGuid && c.getGuid()));
                if (!guid) continue;
                const cfg = c.getConfiguration ? c.getConfiguration() : null;
                const oldAI = cfg && cfg.custom && cfg.custom.autoInit;
                if (!oldAI || typeof oldAI !== 'object') continue;

                // Old format = flat map of fieldId -> { label, useAncestorValue, useAncestorSelf, forceSelfIgnoreFilter }.
                const fields = {};
                for (const fid of Object.keys(oldAI)) {
                    const o = oldAI[fid] || {};
                    const value = !!o.useAncestorValue;
                    const self  = !!o.useAncestorSelf;
                    const force = !!o.forceSelfIgnoreFilter;
                    if (!value && !self) continue;   // only keep fields with an active rule
                    fields[fid] = {
                        label: o.label || '',
                        useAncestorValue: value,
                        useAncestorSelf: self,
                        forceSelfIgnoreFilter: force
                    };
                }
                if (Object.keys(fields).length) {
                    const name = (cfg && cfg.name) || (c.getName && c.getName()) || '';
                    collections[guid] = { name: name, fields: fields };
                }
                cleanup.push(guid);   // clean any collection that carried an autoInit block
            }

            const next = {
                version: 2,
                collections: collections,
                blocklist: central.blocklist || [],
                cleanupPending: cleanup
            };
            this._log('migration: imported', Object.keys(collections).length,
                      'collection(s); cleanup queued for', cleanup.length);
            await this._saveConfig(next);   // persist BEFORE deleting anything (data-safe)
            await this._runCleanup(next);   // best-effort; also retried on next load
        } catch (e) {
            console.error('[auto-init] migration failed:', e);
        }
    }

    /** Remove the old custom.autoInit blocks from collections listed in cleanupPending. */
    async _runCleanup(central) {
        const pending = (central.cleanupPending || []).slice();
        if (!pending.length) return;
        try {
            const list = (await this.data.getAllCollections()) || [];
            const byGuid = new Map();
            for (const c of list) {
                const g = c && (c.guid || (c.getGuid && c.getGuid()));
                if (g) byGuid.set(g, c);
            }
            for (const guid of pending) {
                const c = byGuid.get(guid);
                if (!c || !c.getConfiguration || !c.saveConfiguration) continue;
                const cfg = c.getConfiguration() || {};
                if (cfg.custom && cfg.custom.autoInit) {
                    delete cfg.custom.autoInit;
                    try { await c.saveConfiguration(cfg); }
                    catch (e) { console.error('[auto-init] cleanup save failed for', guid, e); }
                }
            }
            // Base the final save on the passed config (NOT a fresh read — a read right
            // after a save may still be stale and would clobber the version flag).
            const next = Object.assign({}, central, { cleanupPending: [] });
            await this._saveConfig(next);
        } catch (e) {
            console.error('[auto-init] cleanup failed:', e);
        }
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

        // Record the ancestor's collection from the panel so we can read its config later.
        try {
            const coll = panel.getActiveCollection && panel.getActiveCollection();
            this._ancestorCollectionGuid = coll ? (coll.guid || (coll.getGuid && coll.getGuid())) : null;
            if (coll && this._ancestorCollectionGuid) {
                this._collectionsByGuid.set(this._ancestorCollectionGuid, coll);
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
        const panels = this.ui.getPanels ? this.ui.getPanels() : [];
        for (const p of panels) {
            if (p.getType && p.getType() !== 'edit_panel') continue;
            const ar = p.getActiveRecord && p.getActiveRecord();
            if (ar && ar.guid !== newGuid) return ar.guid;
        }
        return null;
    }

    /**
     * A record's own collection guid, read from its "collection" system property (a choice
     * whose value IS the collection guid). Reliable everywhere, including the Journal, unlike
     * panel.getActiveCollection(). Returns null if unavailable.
     */
    _recordCollectionGuid(record) {
        try {
            const p = record && record.prop && record.prop('collection');
            const c = p && p.choice ? p.choice() : null;
            return c || null;
        } catch (e) { return null; }
    }

    /** The collection the current ancestor lives in (from the last panel we saw it in). */
    _ancestorCollection() {
        const g = this._ancestorCollectionGuid;
        if (g && this._collectionsByGuid.has(g)) return this._collectionsByGuid.get(g);
        return null;
    }

    // -------------------- Creation handler --------------------

    _onRecordCreated(ev) {
        if (!ev || !ev.source || !ev.source.isLocal) return;   // don't react to sync-ins
        const newGuid = ev.recordGuid;
        if (!newGuid) return;

        let newCollection = null;
        try { if (ev.getCollection) newCollection = ev.getCollection(); } catch (e) {}
        const newCollectionGuid = ev.collectionGuid || (newCollection && newCollection.guid) || null;

        // Blocklist (new-record side): never auto-init records that ARE in these collections.
        const central = this._readConfig();
        if (newCollectionGuid && central.blocklist.indexOf(newCollectionGuid) !== -1) {
            this._log('new record in blocklisted collection', newCollectionGuid, '— skipping');
            return;
        }

        // Do we even have rules for this collection? If not, skip before any work.
        const rules = newCollectionGuid && central.collections[newCollectionGuid]
            ? (central.collections[newCollectionGuid].fields || null) : null;
        if (!rules || Object.keys(rules).length === 0) {
            this._log('no autoInit rules for collection', newCollectionGuid, '— skipping');
            return;
        }

        const ancestorGuid = this._resolveAncestor(newGuid);
        if (!ancestorGuid) {
            this._log('no ancestor for new record', newGuid, '— skipping');
            return;
        }
        if (ancestorGuid === newGuid) return;

        // (Ancestor-side blocklist is enforced in _applyWithRetry, where the ancestor
        //  RECORD is loaded and we can read its own "collection" property reliably.)

        this._log('schedule apply: new=' + newGuid + ' ancestor=' + ancestorGuid +
                  ' newColl=' + newCollectionGuid);
        this._applyWithRetry(newGuid, ancestorGuid, newCollection, newCollectionGuid, rules, 0);
    }

    _applyWithRetry(newGuid, ancestorGuid, newCollection, newCollectionGuid, rules, attempt) {
        const MAX_ATTEMPTS = 20;   // ~1 second total
        const DELAY_MS = 50;

        const newRecord = this.data.getRecord(newGuid);
        const ancestor  = this.data.getRecord(ancestorGuid);

        if (!newRecord || !ancestor) {
            if (attempt >= MAX_ATTEMPTS) {
                this._log('gave up waiting for records; new=', !!newRecord, 'ancestor=', !!ancestor);
                return;
            }
            setTimeout(() => this._applyWithRetry(newGuid, ancestorGuid, newCollection, newCollectionGuid, rules, attempt + 1), DELAY_MS);
            return;
        }

        // Blocklist, enforced reliably against each record's OWN "collection" system property
        // (holds the collection guid even for the Journal, where panel.getActiveCollection()
        // returns null). Covers both the new record AND the ancestor you're creating it inside.
        const central = this._readConfig();
        const newColl2 = this._recordCollectionGuid(newRecord) || newCollectionGuid;
        const ancColl2 = this._recordCollectionGuid(ancestor)
            || ((ancestorGuid === this._ancestorGuid) ? this._ancestorCollectionGuid : null);
        if (newColl2 && central.blocklist.indexOf(newColl2) !== -1) {
            this._log('new record collection blocklisted', newColl2, '— skipping'); return;
        }
        if (ancColl2 && central.blocklist.indexOf(ancColl2) !== -1) {
            this._log('ancestor collection blocklisted', ancColl2, '— skipping'); return;
        }

        this._withCollection(newCollection, newCollectionGuid, (newColl) => {
            if (!newColl) { this._log('no collection for new record; skipping'); return; }
            this._applyWithCollections(newRecord, ancestor, newColl, rules);
        });
    }

    /**
     * Resolve a PluginCollectionAPI given either the object itself, or a guid.
     * Results are cached on the plugin instance to avoid repeated async work.
     */
    _withCollection(maybeColl, guid, cb) {
        if (maybeColl) return cb(maybeColl);
        if (!guid) return cb(null);

        if (this._collectionsByGuid.has(guid)) {
            return cb(this._collectionsByGuid.get(guid));
        }

        try {
            Promise.resolve(this.data.getAllCollections()).then((list) => {
                for (const c of (list || [])) {
                    const g = c && (c.guid || (c.getGuid && c.getGuid()));
                    if (g) this._collectionsByGuid.set(g, c);
                }
                cb(this._collectionsByGuid.get(guid) || null);
            }).catch((err) => {
                console.error('[auto-init] getAllCollections failed:', err);
                cb(null);
            });
        } catch (e) {
            console.error('[auto-init] _withCollection error:', e);
            cb(null);
        }
    }

    _applyWithCollections(newRecord, ancestor, newColl, rules) {
        const newConfig = newColl.getConfiguration ? newColl.getConfiguration() : null;
        if (!newConfig) { this._log('no config for new record collection; skipping'); return; }

        const ancestorColl = this._ancestorCollection();
        const ancestorConfig = ancestorColl && ancestorColl.getConfiguration
            ? ancestorColl.getConfiguration() : null;
        const sameCollection = ancestorColl && newColl && ancestorColl.guid === newColl.guid;

        // Build label -> field on the ancestor side for cross-collection matching.
        const ancestorFieldsByLabel = new Map();
        if (ancestorConfig && Array.isArray(ancestorConfig.fields)) {
            for (const af of ancestorConfig.fields) {
                if (!af.active || !af.label) continue;
                const key = af.label.trim().toLowerCase();
                if (!ancestorFieldsByLabel.has(key)) ancestorFieldsByLabel.set(key, af);
            }
        }

        const fieldById = new Map();
        for (const f of (newConfig.fields || [])) if (f.active) fieldById.set(f.id, f);

        const applied = [];
        if (this._verbose) console.group('[auto-init] applying to ' + newRecord.guid);

        for (const fieldId of Object.keys(rules)) {
            const opts = rules[fieldId] || {};
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

            // --- Inherit value from ancestor's matching field
            if (useValue) {
                let ancestorField = null;
                if (sameCollection) {
                    ancestorField = (ancestorConfig && Array.isArray(ancestorConfig.fields))
                        ? ancestorConfig.fields.find(f => f.id === fieldId && f.active)
                        : null;
                } else if (field.label) {
                    ancestorField = ancestorFieldsByLabel.get(field.label.trim().toLowerCase()) || null;
                }

                if (ancestorField && ancestorField.type === field.type) {
                    const srcProp = ancestor.prop(ancestorField.id);
                    if (srcProp && !this._isEmpty(srcProp, ancestorField.type)) {
                        this._copyValue(childProp, srcProp, field.type, field, field.filter_colguid || null);
                        didApply = 'ancestor-value';
                    }
                } else if (this._verbose) {
                    console.log('  (value) no matching ancestor field for', fieldId,
                                'label=', field.label, 'sameCollection=', sameCollection);
                }
            }

            // --- Link the ancestor record itself (record fields only)
            if (!didApply && useSelf && field.type === 'record') {
                const forceIgnore = !!opts.forceSelfIgnoreFilter;
                const allowed = this._linkAllowedByCollection(field, ancestorColl && ancestorColl.guid);
                if (forceIgnore || allowed) {
                    childProp.set(ancestor.guid);
                    didApply = (forceIgnore && !allowed) ? 'ancestor-self (filter bypassed)' : 'ancestor-self';
                } else {
                    this._log('  (self) blocked: ancestor collection not allowed by filter_colguid on', fieldId,
                              '— enable "force" to bypass');
                }
            }

            const labelPart = opts.label ? ' "' + opts.label + '"' : '';
            this._log('  field', fieldId + labelPart, '(' + field.type + ')',
                      'useValue=' + useValue, 'useSelf=' + useSelf, '=>', didApply || 'nothing');
            if (didApply) applied.push({ fieldId: fieldId, how: didApply });
        }

        if (this._verbose) {
            console.log('[auto-init] applied:', applied);
            console.groupEnd();
        }
    }

    // -------------------- Value helpers --------------------

    /** Checks filter_colguid against an ancestor collection guid (for self-linking). */
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
     * For record fields we filter out linked records that violate the target's filter_colguid.
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
                    if (linkFilterGuid) {
                        const rc = this._collectionForRecord(r);
                        const rcGuid = rc && (rc.guid || (rc.getGuid && rc.getGuid()));
                        if (rcGuid && rcGuid !== linkFilterGuid) continue;
                    }
                    guids.push(r.guid);
                }
                if (!guids.length) break;
                if (many) target.set(guids); else target.set(guids[0]);
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
        try { if (record.getCollection) return record.getCollection(); } catch (e) {}
        const g = record.collectionGuid || (record.getCollectionGuid && record.getCollectionGuid());
        if (g && this._collectionsByGuid.has(g)) return this._collectionsByGuid.get(g);
        return null;
    }

    // -------------------- Settings UI (two-pane master/detail) --------------------

    isDarkTheme() {
        return !!(document.documentElement.classList.contains('is-dark') || document.querySelector('.is-dark'));
    }
    themeSurfaceColor() {
        const probe = document.querySelector('.panels-grid-sidebar');
        let c = probe ? getComputedStyle(probe).backgroundColor : '';
        if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') {
            c = this.isDarkTheme() ? '#1e1e22' : '#ffffff';
        }
        return c;
    }
    themeBorderColor() {
        return this.isDarkTheme() ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.16)';
    }
    themeShadow() {
        return this.isDarkTheme()
            ? '0 20px 70px rgba(0,0,0,.6), 0 4px 14px rgba(0,0,0,.45)'
            : '0 10px 34px rgba(0,0,0,.12), 0 2px 6px rgba(0,0,0,.07)';
    }

    _injectStyle() {
        const css = `
.aii-backdrop {
    position: fixed; inset: 0; z-index: 99990;
    background: rgba(0,0,0,.38); backdrop-filter: blur(2px);
    display: flex; align-items: flex-start; justify-content: center;
    padding: 6vh 16px 16px;
}
.aii-modal {
    width: min(900px, 96vw); height: min(660px, 86vh);
    display: flex; flex-direction: column;
    background: var(--aii-surface, #1e1e22);
    border: 1px solid var(--aii-border, rgba(127,127,127,.45));
    box-shadow: var(--aii-shadow, 0 20px 70px rgba(0,0,0,.6));
    border-radius: 14px; overflow: hidden;
    color: var(--ed-button-color, var(--text-color, #ddd));
    font-size: 13px; line-height: 1.5;
}
.aii-header {
    display: flex; align-items: center; gap: 10px;
    padding: 15px 18px; border-bottom: 1px solid rgba(127,127,127,.16); flex: none;
}
.aii-title { font-size: 15px; font-weight: 600; flex: 1; }
.aii-x {
    border: 0; background: transparent; color: inherit; cursor: pointer;
    font-size: 20px; line-height: 1; opacity: .6; width: 28px; height: 28px;
    border-radius: 7px; display: flex; align-items: center; justify-content: center;
}
.aii-x:hover { background: rgba(127,127,127,.18); opacity: 1; }

.aii-body { flex: 1; min-height: 0; display: flex; }

/* ---- left pane ---- */
.aii-left {
    width: 270px; flex: none; display: flex; flex-direction: column;
    border-right: 1px solid rgba(127,127,127,.16);
}
.aii-left-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 14px; }
.aii-search {
    width: 100%; box-sizing: border-box; margin: 0 0 16px;
    padding: 8px 11px; border-radius: 9px;
    border: 1px solid rgba(127,127,127,.28); background: rgba(127,127,127,.08);
    color: var(--ed-button-color, inherit); font-size: 13px; outline: none;
}
.aii-search::placeholder { color: currentColor; opacity: .4; }
.aii-search:focus { border-color: var(--ed-button-primary-bg, #3aa37f); }
.aii-section-head { font-size: 11px; font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; opacity: .5; margin: 0 4px 9px; }
.aii-divider { height: 1px; background: rgba(127,127,127,.16); margin: 22px 0 18px; }

.aii-tabs { display: flex; gap: 3px; margin: 14px 14px 0; padding: 3px; flex: none;
    background: rgba(127,127,127,.1); border-radius: 10px; }
.aii-tab { flex: 1; padding: 6px 10px; border: 0; border-radius: 7px; cursor: pointer;
    background: transparent; color: var(--ed-button-color, inherit); opacity: .6;
    font-size: 12.5px; font-weight: 600; }
.aii-tab:hover { opacity: .85; }
.aii-tab.aii-tab-active { background: var(--aii-surface, #2a2a2e); opacity: 1;
    box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.aii-view-block .aii-blocklist { margin-bottom: 10px; }
.aii-coll-list { display: flex; flex-direction: column; gap: 3px; }
.aii-coll-row {
    display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-radius: 9px;
    cursor: pointer; user-select: none;
}
.aii-coll-row:hover { background: rgba(127,127,127,.1); }
.aii-coll-row.aii-sel { background: rgba(127,127,127,.16); }
.aii-coll-row .aii-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aii-coll-row .aii-count {
    font-size: 11px; opacity: .55; padding: 1px 7px; border-radius: 20px;
    background: rgba(127,127,127,.16);
}
.aii-coll-row .aii-count.aii-zero { opacity: .3; background: transparent; }
.aii-row-x {
    border: 0; background: transparent; color: inherit; cursor: pointer; opacity: 0;
    font-size: 16px; line-height: 1; width: 20px; height: 20px; border-radius: 5px; flex: none;
}
.aii-coll-row:hover .aii-row-x { opacity: .45; }
.aii-row-x:hover { background: rgba(127,127,127,.22); opacity: 1 !important; }

.aii-add {
    margin-top: 9px; border: 1px dashed rgba(127,127,127,.35); background: transparent;
    color: var(--ed-button-color, inherit); cursor: pointer; opacity: .85;
    border-radius: 9px; padding: 8px 11px; font-size: 12px; width: 100%; text-align: left;
}
.aii-add:hover { background: rgba(127,127,127,.1); opacity: 1; }
.aii-view-coll .aii-add-coll { margin-top: 0; margin-bottom: 16px; }
.aii-right .aii-add { width: auto; text-align: center; margin-top: 18px; padding: 8px 16px; }
.aii-right .aii-blocklist { max-width: 460px; }

.aii-blocklist { display: flex; flex-direction: column; gap: 6px; }
.aii-block-row {
    display: flex; align-items: center; gap: 8px; padding: 7px 11px;
    border: 1px solid rgba(127,127,127,.2); border-radius: 8px; background: rgba(127,127,127,.05);
}
.aii-block-row > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aii-hint { font-size: 11px; opacity: .5; margin: 9px 4px 0; }
.aii-empty { opacity: .5; font-size: 12px; font-style: italic; padding: 3px 4px; }

/* ---- right pane ---- */
.aii-right { flex: 1; min-width: 0; overflow-y: auto; padding: 18px 22px; }
.aii-right-head { font-size: 15px; font-weight: 600; margin: 2px 0 4px; }
.aii-right-sub { font-size: 12px; opacity: .5; margin-bottom: 16px; }
.aii-placeholder {
    height: 100%; display: flex; align-items: center; justify-content: center;
    text-align: center; opacity: .4; font-size: 13px; padding: 0 24px;
}
.aii-field-row {
    display: flex; align-items: center; gap: 14px; padding: 10px 2px;
    border-bottom: 1px solid rgba(127,127,127,.1);
}
.aii-field-row:last-child { border-bottom: 0; }
.aii-field-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aii-field-type { font-size: 10px; opacity: .4; text-transform: uppercase; letter-spacing: .04em; margin-left: 7px; }
.aii-toggles { display: grid; grid-template-columns: 130px 150px 150px; flex: none; }
.aii-toggle-slot { display: flex; align-items: center; }
.aii-toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; opacity: .85; }
.aii-toggle:hover { opacity: 1; }
.aii-toggle input { accent-color: var(--ed-button-primary-bg, #3aa37f); cursor: pointer; margin: 0; }

/* ---- footer ---- */
.aii-footer {
    display: flex; justify-content: flex-end; gap: 10px; flex: none;
    padding: 14px 18px; border-top: 1px solid rgba(127,127,127,.16);
    background: rgba(127,127,127,.04);
}
.aii-btn {
    border: 1px solid rgba(127,127,127,.28); background: var(--ed-button-bg, transparent);
    color: var(--ed-button-color, inherit); cursor: pointer; border-radius: 9px;
    padding: 8px 18px; font-size: 13px;
}
.aii-btn:hover { background: rgba(127,127,127,.14); }
.aii-primary {
    background: var(--ed-button-primary-bg, #3aa37f) !important;
    border-color: transparent !important; color: #fff !important; font-weight: 600;
}
.aii-primary:disabled { opacity: .6; cursor: default; }

/* ---- picker popup ---- */
.aii-pop {
    position: fixed; z-index: 99995; min-width: 230px; max-height: 320px; overflow-y: auto;
    background: var(--aii-surface, #26262b); border: 1px solid var(--aii-border, rgba(127,127,127,.4));
    border-radius: 10px; box-shadow: 0 16px 48px rgba(0,0,0,.5); padding: 6px;
}
.aii-pop-item { padding: 8px 11px; border-radius: 7px; cursor: pointer; font-size: 13px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aii-pop-item:hover { background: rgba(127,127,127,.16); }
.aii-pop-empty { padding: 10px 11px; opacity: .5; font-size: 12px; font-style: italic; }

/* ---- custom tooltip (native title is unreliable in the Electron shell) ---- */
.aii-tip {
    position: fixed; z-index: 100000; max-width: 290px;
    background: var(--aii-surface, #222); color: var(--ed-button-color, var(--text-color, #ddd));
    border: 1px solid var(--aii-border, rgba(127,127,127,.4)); border-radius: 9px;
    padding: 9px 12px; font-size: 12px; line-height: 1.45;
    box-shadow: 0 10px 32px rgba(0,0,0,.45); pointer-events: none;
    opacity: 0; transition: opacity .1s ease;
}
.aii-tip.aii-tip-show { opacity: 1; }
`;
        let style = document.getElementById('aii-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'aii-style';
            document.head.appendChild(style);
        }
        style.textContent = css;   // always write current CSS (survives plugin reloads)
    }

    async openSettings() {
        if (this._settingsEl) return;
        // Remove any orphaned modal (e.g. left over from a plugin reload).
        document.querySelectorAll('.aii-backdrop').forEach(el => el.remove());
        this._injectStyle();

        let all = [];
        try { all = await this._loadAllCollectionsForUI(); }
        catch (e) { this._toast('Could not load collections', e && (e.message || String(e))); return; }
        this._uiCollections = all;
        this._uiByGuid = new Map(all.map(c => [c.guid, c]));

        // Working model = deep clone of central config (persist only on Save).
        const central = this._readConfig();
        this._model = {
            collections: JSON.parse(JSON.stringify(central.collections || {})),
            blocklist: (central.blocklist || []).slice()
        };
        this._selectedGuid = null;
        this._collFilter = '';

        const backdrop = document.createElement('div');
        backdrop.className = 'aii-backdrop';
        backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) this.closeSettings(); });
        // Custom tooltips on hover (native title is unreliable in the Electron shell).
        backdrop.addEventListener('mouseover', (e) => {
            const t = e.target.closest && e.target.closest('[data-tip]');
            if (t && t !== this._tipFor) { this._tipFor = t; this._showTip(t); }
            else if (!t && this._tipFor) { this._tipFor = null; this._hideTip(); }
        });

        const modal = document.createElement('div');
        modal.className = 'aii-modal';
        modal.style.setProperty('--aii-surface', this.themeSurfaceColor());
        modal.style.setProperty('--aii-border', this.themeBorderColor());
        modal.style.setProperty('--aii-shadow', this.themeShadow());

        modal.innerHTML = `
<div class="aii-header">
    <span class="aii-title">Auto-Init</span>
    <button class="aii-x" title="Close">×</button>
</div>
<div class="aii-body">
    <div class="aii-left">
        <div class="aii-tabs">
            <button class="aii-tab aii-tab-coll aii-tab-active">Collections</button>
            <button class="aii-tab aii-tab-block">Blocklist</button>
        </div>
        <div class="aii-left-scroll">
            <div class="aii-view-coll">
                <input class="aii-search" type="text" placeholder="Search collections…" spellcheck="false">
                <button class="aii-add aii-add-coll">+ Add collection</button>
                <div class="aii-coll-list"></div>
            </div>
            <div class="aii-view-block" hidden>
                <div class="aii-blocklist"></div>
                <button class="aii-add aii-add-block">+ Add collection</button>
            </div>
        </div>
    </div>
    <div class="aii-right"></div>
</div>
<div class="aii-footer">
    <button class="aii-btn aii-cancel">Close</button>
    <button class="aii-btn aii-primary aii-save">Save</button>
</div>`;

        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        this._settingsEl = backdrop;

        modal.querySelector('.aii-x').addEventListener('click', () => this.closeSettings());
        modal.querySelector('.aii-cancel').addEventListener('click', () => this.closeSettings());
        modal.querySelector('.aii-save').addEventListener('click', (e) => this._saveSettings(e.currentTarget));
        modal.querySelector('.aii-add-coll').addEventListener('click', (e) => this._openCollPicker(e.currentTarget));
        modal.querySelector('.aii-add-block').addEventListener('click', (e) => this._openBlockPicker(e.currentTarget));
        modal.querySelector('.aii-tab-coll').addEventListener('click', () => this._setTab('collections'));
        modal.querySelector('.aii-tab-block').addEventListener('click', () => this._setTab('blocklist'));
        const search = modal.querySelector('.aii-search');
        search.addEventListener('input', () => {
            this._collFilter = search.value.trim().toLowerCase();
            this._renderCollList();
        });

        this._tab = 'collections';
        this._renderCollList();
        this._renderBlocklist();
        this._renderRight();   // placeholder until a collection is selected
    }

    closeSettings() {
        this._closePop();
        this._hideTip();
        if (this._tip) { this._tip.remove(); this._tip = null; }
        this._tipFor = null;
        if (this._settingsEl) { this._settingsEl.remove(); this._settingsEl = null; }
        this._model = null; this._uiCollections = null; this._uiByGuid = null; this._selectedGuid = null;
    }

    _showTip(el) {
        const text = el.getAttribute('data-tip');
        if (!text) { this._hideTip(); return; }
        let tip = this._tip;
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'aii-tip';
            document.body.appendChild(tip);
            this._tip = tip;
        }
        tip.textContent = text;
        tip.style.setProperty('--aii-surface', this.themeSurfaceColor());
        tip.style.setProperty('--aii-border', this.themeBorderColor());
        // Measure, then position above the toggle (flip below if no room), clamped on-screen.
        tip.classList.add('aii-tip-show');
        const r = el.getBoundingClientRect();
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let left = r.left + r.width / 2 - tw / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - 8 - tw));
        let top = r.top - th - 8;
        if (top < 8) top = r.bottom + 8;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
    }

    _hideTip() {
        if (this._tip) this._tip.classList.remove('aii-tip-show');
    }

    async _loadAllCollectionsForUI() {
        const list = (await this.data.getAllCollections()) || [];
        const out = [];
        for (const c of list) {
            const guid = c && (c.guid || (c.getGuid && c.getGuid()));
            if (!guid) continue;
            this._collectionsByGuid.set(guid, c);
            const cfg = c.getConfiguration ? c.getConfiguration() : null;
            const name = (cfg && cfg.name) || (c.getName && c.getName()) || '(unnamed)';
            const fields = [];
            for (const f of ((cfg && cfg.fields) || [])) {
                if (!f.active || f.read_only || f.type === 'dynamic') continue;
                fields.push({ id: f.id, label: f.label || '', type: f.type, filterColguid: f.filter_colguid || null });
            }
            out.push({ guid: guid, name: name, fields: fields });
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }

    _collName(guid) {
        const desc = this._uiByGuid.get(guid);
        const stored = this._model.collections[guid];
        return (desc && desc.name) || (stored && stored.name) || guid;
    }

    /** Name of any collection by guid, or null if unknown (for the "Ignore filter" tooltip). */
    _collNameFromAll(guid) {
        const c = this._uiByGuid.get(guid);
        return (c && c.name) || null;
    }

    _activeCount(guid) {
        const stored = this._model.collections[guid];
        if (!stored) return 0;
        return Object.keys(stored.fields || {}).filter(fid => {
            const r = stored.fields[fid];
            return r && (r.useAncestorValue || r.useAncestorSelf);
        }).length;
    }

    _renderCollList() {
        const wrap = this._settingsEl.querySelector('.aii-coll-list');
        wrap.innerHTML = '';
        const allGuids = Object.keys(this._model.collections);
        if (!allGuids.length) {
            wrap.innerHTML = '<div class="aii-empty">None yet — add one below.</div>';
            return;
        }
        let guids = allGuids.slice().sort((a, b) => this._collName(a).localeCompare(this._collName(b)));
        const filter = this._collFilter || '';
        if (filter) guids = guids.filter(g => this._collName(g).toLowerCase().includes(filter));
        if (!guids.length) {
            wrap.innerHTML = '<div class="aii-empty">No matches.</div>';
            return;
        }
        for (const guid of guids) {
            const count = this._activeCount(guid);
            const row = document.createElement('div');
            row.className = 'aii-coll-row' + (guid === this._selectedGuid ? ' aii-sel' : '');
            row.dataset.guid = guid;
            row.innerHTML = `<span class="aii-name"></span>
                <span class="aii-count ${count ? '' : 'aii-zero'}">${count}</span>
                <button class="aii-row-x" title="Remove">×</button>`;
            row.querySelector('.aii-name').textContent = this._collName(guid);
            row.addEventListener('click', (e) => {
                if (e.target.closest('.aii-row-x')) return;
                this._selectCollection(guid);
            });
            row.querySelector('.aii-row-x').addEventListener('click', (e) => {
                e.stopPropagation();
                delete this._model.collections[guid];
                if (this._selectedGuid === guid) this._selectedGuid = null;
                this._renderCollList();
                this._renderRight();
            });
            wrap.appendChild(row);
        }
    }

    _selectCollection(guid) {
        this._selectedGuid = guid;
        this._renderCollList();
        this._renderRight();
    }

    /** Switch the left pane between the Collections and Blocklist tabs. */
    _setTab(tab) {
        this._tab = tab;
        const root = this._settingsEl;
        root.querySelector('.aii-tab-coll').classList.toggle('aii-tab-active', tab === 'collections');
        root.querySelector('.aii-tab-block').classList.toggle('aii-tab-active', tab === 'blocklist');
        root.querySelector('.aii-view-coll').hidden = tab !== 'collections';
        root.querySelector('.aii-view-block').hidden = tab !== 'blocklist';
        this._renderRight();
    }

    _renderRight() {
        const right = this._settingsEl.querySelector('.aii-right');

        if (this._tab === 'blocklist') {
            right.innerHTML =
                '<div class="aii-right-head">Blocklist</div>' +
                '<div class="aii-right-sub">Auto-init is skipped when the record you’re inside, or the new record, is in one of these (e.g. your Journal). Add collections in the list on the left to block them.</div>';
            return;
        }

        const guid = this._selectedGuid;
        if (!guid || !this._model.collections[guid]) {
            right.innerHTML = '<div class="aii-placeholder">Select a collection on the left to configure which fields inherit from the ancestor record.</div>';
            return;
        }
        const desc = this._uiByGuid.get(guid);
        const stored = this._model.collections[guid];
        const fields = (desc && desc.fields) || [];

        right.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'aii-right-head';
        head.textContent = this._collName(guid);
        right.appendChild(head);
        const sub = document.createElement('div');
        sub.className = 'aii-right-sub';
        sub.textContent = 'New records inherit from the ancestor you create them inside.';
        right.appendChild(sub);

        if (!fields.length) {
            const e = document.createElement('div');
            e.className = 'aii-empty';
            e.textContent = 'This collection has no configurable fields.';
            right.appendChild(e);
            return;
        }

        const valueTip = 'Copy the ancestor’s value from its matching field into the new record.';
        const selfTip = 'Link the ancestor record itself into this field.';
        for (const f of fields) {
            const rule = stored.fields[f.id] || {};
            const isRecord = f.type === 'record';
            // "Ignore filter" only does something on record fields that have a
            // "Filter by collection" set — so only show it there, with an explanation.
            const hasFilter = isRecord && !!f.filterColguid;
            const filteredName = hasFilter ? this._collNameFromAll(f.filterColguid) : null;
            const forceTip = !hasFilter ? '' : (filteredName
                ? 'This field is set to only link records from “' + filteredName + '”. Turn on to link the ' +
                  'ancestor anyway, even when it is from another collection.'
                : 'This field is set to only link records from one specific collection. Turn on to link the ' +
                  'ancestor anyway, even when it is from another collection.');

            const row = document.createElement('div');
            row.className = 'aii-field-row';

            const valueSlot = '<div class="aii-toggle-slot"><label class="aii-toggle" data-tip="' + this._esc(valueTip) +
                '"><input type="checkbox" data-flag="value"> Copy value</label></div>';
            const selfSlot = isRecord
                ? '<div class="aii-toggle-slot"><label class="aii-toggle" data-tip="' + this._esc(selfTip) +
                  '"><input type="checkbox" data-flag="self"> Link ancestor</label></div>'
                : '<div class="aii-toggle-slot"></div>';
            const forceSlot = hasFilter
                ? '<div class="aii-toggle-slot"><label class="aii-toggle" data-tip="' + this._esc(forceTip) +
                  '"><input type="checkbox" data-flag="force"> Ignore filter</label></div>'
                : '<div class="aii-toggle-slot"></div>';

            row.innerHTML =
                '<span class="aii-field-label" title="' + this._esc(f.label) + '">' + this._esc(f.label || f.id) +
                '<span class="aii-field-type">' + this._esc(f.type) + '</span></span>' +
                '<span class="aii-toggles">' + valueSlot + selfSlot + forceSlot + '</span>';

            const cbValue = row.querySelector('[data-flag="value"]');
            const cbSelf  = row.querySelector('[data-flag="self"]');
            const cbForce = row.querySelector('[data-flag="force"]');
            cbValue.checked = !!rule.useAncestorValue;
            if (cbSelf)  cbSelf.checked  = !!rule.useAncestorSelf;
            if (cbForce) cbForce.checked = !!rule.forceSelfIgnoreFilter;

            const onChange = () => {
                const value = cbValue.checked;
                const self  = cbSelf  ? cbSelf.checked  : false;
                const force = cbForce ? cbForce.checked : false;
                if (!value && !self && !force) {
                    delete stored.fields[f.id];
                } else {
                    stored.fields[f.id] = {
                        label: f.label || '',
                        useAncestorValue: value,
                        useAncestorSelf: self,
                        forceSelfIgnoreFilter: force
                    };
                }
                // Keep the left-list count badge fresh.
                const badge = this._settingsEl.querySelector('.aii-coll-row[data-guid="' + guid + '"] .aii-count');
                if (badge) {
                    const c = this._activeCount(guid);
                    badge.textContent = c;
                    badge.classList.toggle('aii-zero', !c);
                }
            };
            cbValue.addEventListener('change', onChange);
            if (cbSelf)  cbSelf.addEventListener('change', onChange);
            if (cbForce) cbForce.addEventListener('change', onChange);
            right.appendChild(row);
        }
    }

    _renderBlocklist() {
        const wrap = this._settingsEl.querySelector('.aii-blocklist');
        if (!wrap) return;
        wrap.innerHTML = '';
        if (!this._model.blocklist.length) {
            wrap.innerHTML = '<div class="aii-empty">None. Add a collection to skip auto-init in it (e.g. your Journal).</div>';
            return;
        }
        for (const guid of this._model.blocklist) {
            const row = document.createElement('div');
            row.className = 'aii-block-row';
            row.innerHTML = `<span></span><button class="aii-row-x" title="Remove">×</button>`;
            row.querySelector('span').textContent = this._collName(guid);
            row.querySelector('.aii-row-x').addEventListener('click', () => {
                this._model.blocklist = this._model.blocklist.filter(g => g !== guid);
                this._renderBlocklist();
            });
            wrap.appendChild(row);
        }
    }

    _openCollPicker(anchor) {
        const used = new Set(Object.keys(this._model.collections));
        const items = this._uiCollections.filter(c => !used.has(c.guid));
        this._openPicker(anchor, items, (c) => {
            this._model.collections[c.guid] = { name: c.name, fields: {} };
            this._renderCollList();
            this._selectCollection(c.guid);   // jump straight to its fields
        });
    }

    _openBlockPicker(anchor) {
        const used = new Set(this._model.blocklist);
        const items = this._uiCollections.filter(c => !used.has(c.guid));
        this._openPicker(anchor, items, (c) => {
            this._model.blocklist.push(c.guid);
            this._renderBlocklist();
        });
    }

    _openPicker(anchor, items, onPick) {
        this._closePop();
        const pop = document.createElement('div');
        pop.className = 'aii-pop';
        pop.style.setProperty('--aii-surface', this.themeSurfaceColor());
        pop.style.setProperty('--aii-border', this.themeBorderColor());
        if (!items.length) {
            pop.innerHTML = '<div class="aii-pop-empty">Nothing left to add.</div>';
        } else {
            for (const c of items) {
                const it = document.createElement('div');
                it.className = 'aii-pop-item';
                it.textContent = c.name;
                it.addEventListener('click', () => { this._closePop(); onPick(c); });
                pop.appendChild(it);
            }
        }
        document.body.appendChild(pop);
        const r = anchor.getBoundingClientRect();
        const w = pop.offsetWidth;
        let left = r.left;
        if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
        if (left < 8) left = 8;
        let top = r.bottom + 6;
        if (top + pop.offsetHeight > window.innerHeight - 8) top = r.top - pop.offsetHeight - 6;
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
        this._pop = pop;
        this._popDismiss = (e) => { if (!pop.contains(e.target) && e.target !== anchor) this._closePop(); };
        setTimeout(() => document.addEventListener('pointerdown', this._popDismiss, true), 0);
    }

    _closePop() {
        if (this._pop) { this._pop.remove(); this._pop = null; }
        if (this._popDismiss) { document.removeEventListener('pointerdown', this._popDismiss, true); this._popDismiss = null; }
    }

    async _saveSettings(saveBtn) {
        saveBtn.disabled = true;
        const original = saveBtn.textContent;
        saveBtn.textContent = 'Saving…';
        try {
            // Prune empty collections / fields with no active flags.
            const collections = {};
            for (const guid of Object.keys(this._model.collections)) {
                const stored = this._model.collections[guid];
                const fields = {};
                for (const fid of Object.keys(stored.fields || {})) {
                    const r = stored.fields[fid];
                    if (r && (r.useAncestorValue || r.useAncestorSelf)) fields[fid] = r;
                }
                if (Object.keys(fields).length) {
                    const desc = this._uiByGuid.get(guid);
                    collections[guid] = { name: (desc && desc.name) || stored.name || '', fields: fields };
                }
            }
            const current = this._readConfig();
            const next = {
                version: 2,
                collections: collections,
                blocklist: this._model.blocklist.slice(),
                cleanupPending: current.cleanupPending || []
            };
            await this._saveConfig(next);   // reloads the plugin → modal closes
            this.closeSettings();
            this._toast('Auto-Init settings saved');
        } catch (e) {
            saveBtn.disabled = false;
            saveBtn.textContent = original;
            this._toast('Could not save settings', e && (e.message || String(e)));
        }
    }

    // -------------------- Tiny utils --------------------

    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

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
