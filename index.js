import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    appendMediaToMessage,
    saveChatConditional,
    generateQuietPrompt,
} from '../../../../script.js';

/* -------------------------------------------------------------------------- */
/*  Constants & defaults                                                       */
/* -------------------------------------------------------------------------- */

const MODULE_NAME = 'imageEmbed';
const DB_NAME = 'ImageEmbedDB';
const DB_STORE = 'images';
const DB_VERSION = 1;

const defaultSettings = {
    enabled: true,
    scope: 'global',              // global | character | chat
    triggerMode: 'auto',          // auto | manual
    matchMethod: 'ai',            // ai | keyword
    triggerChance: 100,           // 0-100 (%) chance to attempt a pick on auto
    maxImagesInPrompt: 30,        // cap candidates handed to the AI
    recentMessages: 4,            // how many recent messages form the scene context
    keywordThreshold: 1,          // minimum keyword score for a keyword match
    allowRepeats: false,          // allow the same image to be picked twice in a row
    collections: {},              // { scopeKey: [ imageMeta, ... ] }
};

// Per-scope memory of the last image picked (avoid back-to-back repeats).
const lastPicked = {};

let isProcessing = false;

/* -------------------------------------------------------------------------- */
/*  Settings helpers                                                           */
/* -------------------------------------------------------------------------- */

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    // Backfill any missing keys after an update.
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }
    return extension_settings[MODULE_NAME];
}

function save() {
    saveSettingsDebounced();
}

/** Resolve the storage key for the currently active scope. */
function getScopeKey() {
    const settings = getSettings();
    const ctx = getContext();
    switch (settings.scope) {
        case 'character': {
            if (ctx.groupId) return `group_${ctx.groupId}`;
            const char = ctx.characters?.[ctx.characterId];
            return `char_${char?.avatar || char?.name || 'unknown'}`;
        }
        case 'chat':
            return `chat_${ctx.getCurrentChatId() || 'none'}`;
        case 'global':
        default:
            return 'global';
    }
}

/** Get (and lazily create) the image collection array for the active scope. */
function getCollection() {
    const settings = getSettings();
    const key = getScopeKey();
    if (!Array.isArray(settings.collections[key])) {
        settings.collections[key] = [];
    }
    return settings.collections[key];
}

/* -------------------------------------------------------------------------- */
/*  IndexedDB (stores the actual image data so settings.json stays small)      */
/* -------------------------------------------------------------------------- */

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(DB_STORE)) {
                db.createObjectStore(DB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbPut(id, dataUrl) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(dataUrl, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function idbGet(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/* -------------------------------------------------------------------------- */
/*  Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function uuid() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function stripHtml(str) {
    const tmp = document.createElement('div');
    tmp.innerHTML = String(str ?? '');
    return (tmp.textContent || tmp.innerText || '').trim();
}

function toast(msg, type = 'info') {
    if (typeof toastr !== 'undefined') {
        toastr[type]?.(msg, 'Image Embed');
    } else {
        console.log(`[ImageEmbed] ${msg}`);
    }
}

/** Return a displayable src for an image entry (URL passthrough or IDB blob). */
async function resolveImageSrc(img) {
    if (!img) return null;
    if (img.type === 'url') return img.url;
    if (img._dataUrl) return img._dataUrl;            // in-memory cache
    const data = await idbGet(img.id);
    if (data) img._dataUrl = data;
    return data || null;
}

/* -------------------------------------------------------------------------- */
/*  Scene matching                                                             */
/* -------------------------------------------------------------------------- */

/** Plain-text snapshot of the last few messages, oldest first. */
function getRecentContextText() {
    const settings = getSettings();
    const ctx = getContext();
    const count = Math.max(1, Number(settings.recentMessages) || 4);
    const slice = ctx.chat.slice(-count);
    return slice
        .filter((m) => !m.is_system)
        .map((m) => `${m.name}: ${stripHtml(m.mes)}`)
        .join('\n');
}

function describeImage(img, index) {
    const parts = [`[${index}]`];
    if (img.name) parts.push(`Name: ${img.name}`);
    if (img.character) parts.push(`Character: ${img.character}`);
    if (img.scene) parts.push(`Scene: ${img.scene}`);
    if (img.context) parts.push(`Context: ${img.context}`);
    if (img.keywords) parts.push(`Keywords: ${img.keywords}`);
    return parts.join(' | ');
}

/** Keyword scoring fallback that requires no extra LLM call. */
function keywordPick(candidates) {
    const haystack = getRecentContextText().toLowerCase();
    if (!haystack) return null;

    let best = null;
    let bestScore = 0;

    for (const img of candidates) {
        const terms = [];
        if (img.keywords) terms.push(...img.keywords.split(/[,;\n]/));
        if (img.character) terms.push(...img.character.split(/[,;\n\s]/));
        if (img.scene) terms.push(...img.scene.split(/[,;\n\s]/));

        let score = 0;
        for (let term of terms) {
            term = term.trim().toLowerCase();
            if (term.length < 2) continue;
            if (haystack.includes(term)) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            best = img;
        }
    }

    const settings = getSettings();
    return bestScore >= (Number(settings.keywordThreshold) || 1) ? best : null;
}

/** Ask the model to choose the best image for the current scene. */
async function aiPick(candidates) {
    const sceneText = getRecentContextText();
    if (!sceneText) return null;

    const list = candidates.map((img, i) => describeImage(img, i + 1)).join('\n');

    const prompt =
        'You are an image-selection assistant for a roleplay. ' +
        'Given the recent conversation and a numbered list of available images, ' +
        'choose the single image that best fits the current scene, mood, or character. ' +
        'If none of them fit well, answer 0.\n\n' +
        '### Recent conversation\n' + sceneText + '\n\n' +
        '### Available images\n' + list + '\n\n' +
        'Reply with ONLY the number of the best image (or 0 for none). No other text.';

    let response;
    try {
        response = await generateQuietPrompt(prompt, false, true, null, null, 30);
    } catch (err) {
        console.error('[ImageEmbed] generateQuietPrompt failed, falling back to keywords.', err);
        return keywordPick(candidates);
    }

    const match = String(response || '').match(/\d+/);
    if (!match) return null;
    const idx = parseInt(match[0], 10);
    if (!idx || idx < 1 || idx > candidates.length) return null;
    return candidates[idx - 1];
}

async function pickImage() {
    const settings = getSettings();
    let candidates = getCollection().filter((img) => img.enabled !== false);

    // Avoid repeating the previous pick when configured.
    const key = getScopeKey();
    if (!settings.allowRepeats && candidates.length > 1 && lastPicked[key]) {
        candidates = candidates.filter((img) => img.id !== lastPicked[key]);
    }
    if (!candidates.length) return null;

    if (candidates.length > settings.maxImagesInPrompt) {
        candidates = candidates.slice(0, settings.maxImagesInPrompt);
    }

    const picked = settings.matchMethod === 'keyword'
        ? keywordPick(candidates)
        : await aiPick(candidates);

    if (picked) lastPicked[key] = picked.id;
    return picked;
}

/* -------------------------------------------------------------------------- */
/*  Attaching images to chat                                                   */
/* -------------------------------------------------------------------------- */

async function attachImageToMessage(messageId, img) {
    const ctx = getContext();
    const message = ctx.chat[messageId];
    if (!message) return false;

    const src = await resolveImageSrc(img);
    if (!src) {
        toast('Could not load the selected image data.', 'warning');
        return false;
    }

    message.extra = message.extra || {};
    message.extra.image = src;
    message.extra.title = img.name || img.scene || '';
    message.extra.inline_image = true;

    const mesDom = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (mesDom) {
        appendMediaToMessage(message, $(mesDom));
    }
    await saveChatConditional();
    return true;
}

/** Event handler: a fresh character message just rendered. */
async function onCharacterMessageRendered(messageId) {
    const settings = getSettings();
    if (!settings.enabled || settings.triggerMode !== 'auto') return;
    if (isProcessing) return;

    const ctx = getContext();
    // Only act on the newest message to avoid reprocessing history.
    if (messageId !== ctx.chat.length - 1) return;

    const message = ctx.chat[messageId];
    if (!message || message.is_user || message.is_system) return;
    if (message.extra?.image) return; // already has an image

    if (Math.random() * 100 > (Number(settings.triggerChance) || 0)) return;
    if (!getCollection().some((img) => img.enabled !== false)) return;

    isProcessing = true;
    try {
        const picked = await pickImage();
        if (picked) {
            await attachImageToMessage(messageId, picked);
        }
    } catch (err) {
        console.error('[ImageEmbed] Auto-trigger failed.', err);
    } finally {
        isProcessing = false;
    }
}

/** Manual trigger: pick an image for the most recent character message. */
async function manualTrigger() {
    const settings = getSettings();
    const ctx = getContext();

    let messageId = ctx.chat.length - 1;
    while (messageId >= 0 && (ctx.chat[messageId].is_user || ctx.chat[messageId].is_system)) {
        messageId--;
    }
    if (messageId < 0) {
        toast('No character message to attach an image to.', 'warning');
        return;
    }
    if (!getCollection().some((img) => img.enabled !== false)) {
        toast('No images available in the current scope.', 'warning');
        return;
    }

    isProcessing = true;
    try {
        const picked = await pickImage();
        if (picked) {
            const ok = await attachImageToMessage(messageId, picked);
            if (ok) toast(`Attached "${picked.name || picked.scene || 'image'}".`, 'success');
        } else {
            toast('No fitting image was found for the current scene.', 'info');
        }
    } finally {
        isProcessing = false;
    }
}

/* -------------------------------------------------------------------------- */
/*  Image CRUD                                                                 */
/* -------------------------------------------------------------------------- */

async function addImage({ type, url, dataUrl, name, character, scene, context, keywords }) {
    const id = uuid();
    const meta = {
        id,
        type,
        name: name || '',
        character: character || '',
        scene: scene || '',
        context: context || '',
        keywords: keywords || '',
        enabled: true,
    };
    if (type === 'url') {
        meta.url = url;
    } else {
        await idbPut(id, dataUrl);
        meta._dataUrl = dataUrl;
    }
    getCollection().push(meta);
    save();
    return meta;
}

async function deleteImage(id) {
    const collection = getCollection();
    const idx = collection.findIndex((img) => img.id === id);
    if (idx === -1) return;
    if (collection[idx].type !== 'url') {
        await idbDelete(id).catch(() => {});
    }
    collection.splice(idx, 1);
    save();
}

function updateImageField(id, field, value) {
    const img = getCollection().find((i) => i.id === id);
    if (!img) return;
    img[field] = value;
    save();
}

/* -------------------------------------------------------------------------- */
/*  Import / export                                                            */
/* -------------------------------------------------------------------------- */

async function exportCollection() {
    const collection = getCollection();
    const out = [];
    for (const img of collection) {
        const entry = { ...img };
        delete entry._dataUrl;
        if (img.type !== 'url') {
            entry.dataUrl = await resolveImageSrc(img);
        }
        out.push(entry);
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `image-embed-${getScopeKey()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
}

async function importCollection(file) {
    const text = await file.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        toast('Invalid JSON file.', 'error');
        return;
    }
    if (!Array.isArray(data)) {
        toast('Unexpected file format.', 'error');
        return;
    }
    for (const entry of data) {
        await addImage({
            type: entry.type === 'url' ? 'url' : 'file',
            url: entry.url,
            dataUrl: entry.dataUrl,
            name: entry.name,
            character: entry.character,
            scene: entry.scene,
            context: entry.context,
            keywords: entry.keywords,
        });
    }
    toast(`Imported ${data.length} image(s).`, 'success');
    renderGallery();
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                         */
/* -------------------------------------------------------------------------- */

const settingsHtml = `
<div class="image-embed-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Image Embed &amp; Auto-Trigger</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <small class="ie-hint">
                Store images (files or links) with descriptions, and let the AI pick the one
                that best fits the current scene and attach it to chat.
            </small>

            <label class="checkbox_label" for="ie_enabled">
                <input type="checkbox" id="ie_enabled">
                <span>Enable extension</span>
            </label>

            <div class="ie-row">
                <label for="ie_scope">Storage scope</label>
                <select id="ie_scope" class="text_pole">
                    <option value="global">Global (all chats)</option>
                    <option value="character">Per character / group</option>
                    <option value="chat">Per chat</option>
                </select>
            </div>

            <div class="ie-row">
                <label for="ie_triggerMode">Trigger mode</label>
                <select id="ie_triggerMode" class="text_pole">
                    <option value="auto">Automatic (after each AI message)</option>
                    <option value="manual">Manual only</option>
                </select>
            </div>

            <div class="ie-row">
                <label for="ie_matchMethod">Selection method</label>
                <select id="ie_matchMethod" class="text_pole">
                    <option value="ai">AI picks (extra request)</option>
                    <option value="keyword">Keyword match (no request)</option>
                </select>
            </div>

            <div class="ie-row">
                <label for="ie_triggerChance">Trigger chance (%)</label>
                <input type="number" id="ie_triggerChance" class="text_pole" min="0" max="100" step="5">
            </div>

            <div class="ie-row">
                <label for="ie_recentMessages">Scene context (messages)</label>
                <input type="number" id="ie_recentMessages" class="text_pole" min="1" max="20" step="1">
            </div>

            <div class="ie-row">
                <label for="ie_maxImagesInPrompt">Max images per request</label>
                <input type="number" id="ie_maxImagesInPrompt" class="text_pole" min="1" max="100" step="1">
            </div>

            <div class="ie-row">
                <label for="ie_keywordThreshold">Keyword match threshold</label>
                <input type="number" id="ie_keywordThreshold" class="text_pole" min="1" max="10" step="1">
            </div>

            <label class="checkbox_label" for="ie_allowRepeats">
                <input type="checkbox" id="ie_allowRepeats">
                <span>Allow the same image twice in a row</span>
            </label>

            <hr>

            <div class="ie-add-form">
                <b>Add image</b>
                <div class="ie-add-source">
                    <input type="text" id="ie_add_url" class="text_pole" placeholder="Image URL (https://...)">
                    <span class="ie-or">or</span>
                    <input type="file" id="ie_add_file" accept="image/*">
                </div>
                <input type="text" id="ie_add_name" class="text_pole" placeholder="Name (optional)">
                <input type="text" id="ie_add_character" class="text_pole" placeholder="Character (who is in / shows this)">
                <input type="text" id="ie_add_scene" class="text_pole" placeholder="Scene (e.g. forest at night, blushing)">
                <textarea id="ie_add_context" class="text_pole" rows="2" placeholder="Context / description used for matching"></textarea>
                <input type="text" id="ie_add_keywords" class="text_pole" placeholder="Keywords (comma separated)">
                <div class="ie-buttons">
                    <div id="ie_add_btn" class="menu_button">Add image</div>
                </div>
            </div>

            <hr>

            <div class="ie-gallery-header">
                <b>Stored images (<span id="ie_scope_label">global</span>): <span id="ie_count">0</span></b>
                <div class="ie-buttons">
                    <div id="ie_trigger_btn" class="menu_button" title="Pick an image for the latest message">Pick now</div>
                    <div id="ie_export_btn" class="menu_button">Export</div>
                    <div id="ie_import_btn" class="menu_button">Import</div>
                    <input type="file" id="ie_import_file" accept="application/json" style="display:none">
                </div>
            </div>
            <div id="ie_gallery" class="ie-gallery"></div>
        </div>
    </div>
</div>
`;

function bindControl(id, settingKey, { checkbox = false, number = false } = {}) {
    const settings = getSettings();
    const el = document.getElementById(id);
    if (!el) return;
    if (checkbox) {
        el.checked = !!settings[settingKey];
        el.addEventListener('change', () => {
            settings[settingKey] = el.checked;
            save();
        });
    } else {
        el.value = settings[settingKey];
        el.addEventListener('change', () => {
            settings[settingKey] = number ? Number(el.value) : el.value;
            save();
            if (settingKey === 'scope') renderGallery();
        });
    }
}

async function renderGallery() {
    const container = document.getElementById('ie_gallery');
    if (!container) return;

    const settings = getSettings();
    document.getElementById('ie_scope_label').textContent = settings.scope;

    const collection = getCollection();
    document.getElementById('ie_count').textContent = collection.length;
    container.innerHTML = '';

    if (!collection.length) {
        container.innerHTML = '<small class="ie-hint">No images stored in this scope yet.</small>';
        return;
    }

    for (const img of collection) {
        const card = document.createElement('div');
        card.className = 'ie-card';
        card.innerHTML = `
            <div class="ie-thumb-wrap">
                <img class="ie-thumb" alt="${escapeHtml(img.name)}">
                <label class="checkbox_label ie-enable">
                    <input type="checkbox" class="ie-field" data-field="enabled" ${img.enabled !== false ? 'checked' : ''}>
                    <span>On</span>
                </label>
            </div>
            <div class="ie-fields">
                <input type="text" class="text_pole ie-field" data-field="name" value="${escapeHtml(img.name)}" placeholder="Name">
                <input type="text" class="text_pole ie-field" data-field="character" value="${escapeHtml(img.character)}" placeholder="Character">
                <input type="text" class="text_pole ie-field" data-field="scene" value="${escapeHtml(img.scene)}" placeholder="Scene">
                <textarea class="text_pole ie-field" data-field="context" rows="2" placeholder="Context">${escapeHtml(img.context)}</textarea>
                <input type="text" class="text_pole ie-field" data-field="keywords" value="${escapeHtml(img.keywords)}" placeholder="Keywords">
                <div class="ie-buttons">
                    <div class="menu_button ie-delete">Delete</div>
                </div>
            </div>
        `;

        // Load thumbnail.
        const thumb = card.querySelector('.ie-thumb');
        resolveImageSrc(img).then((src) => { if (src) thumb.src = src; });

        // Field bindings.
        card.querySelectorAll('.ie-field').forEach((field) => {
            const name = field.dataset.field;
            const evt = field.type === 'checkbox' ? 'change' : 'input';
            field.addEventListener(evt, () => {
                const value = field.type === 'checkbox' ? field.checked : field.value;
                updateImageField(img.id, name, value);
            });
        });

        card.querySelector('.ie-delete').addEventListener('click', async () => {
            await deleteImage(img.id);
            renderGallery();
        });

        container.appendChild(card);
    }
}

async function onAddClick() {
    const url = document.getElementById('ie_add_url').value.trim();
    const fileInput = document.getElementById('ie_add_file');
    const file = fileInput.files?.[0];
    const meta = {
        name: document.getElementById('ie_add_name').value.trim(),
        character: document.getElementById('ie_add_character').value.trim(),
        scene: document.getElementById('ie_add_scene').value.trim(),
        context: document.getElementById('ie_add_context').value.trim(),
        keywords: document.getElementById('ie_add_keywords').value.trim(),
    };

    if (!url && !file) {
        toast('Provide an image URL or choose a file.', 'warning');
        return;
    }

    try {
        if (file) {
            const dataUrl = await fileToDataUrl(file);
            await addImage({ type: 'file', dataUrl, ...meta });
        } else {
            await addImage({ type: 'url', url, ...meta });
        }
    } catch (err) {
        console.error('[ImageEmbed] Failed to add image.', err);
        toast('Failed to add image.', 'error');
        return;
    }

    // Reset form.
    ['ie_add_url', 'ie_add_name', 'ie_add_character', 'ie_add_scene', 'ie_add_context', 'ie_add_keywords']
        .forEach((id) => { document.getElementById(id).value = ''; });
    fileInput.value = '';

    toast('Image added.', 'success');
    renderGallery();
}

/** Enable toggle: reload the page when the extension is switched off so its
 *  event listeners and UI are torn down cleanly. */
function bindEnabledControl() {
    const settings = getSettings();
    const el = document.getElementById('ie_enabled');
    if (!el) return;
    el.checked = !!settings.enabled;
    el.addEventListener('change', async () => {
        settings.enabled = el.checked;
        if (el.checked) {
            save();
            return;
        }
        toast('Extension disabled — reloading the page…', 'info');
        // Make sure the disabled state is persisted before the reload fires.
        let savedImmediately = false;
        try {
            const mod = await import('../../../../script.js');
            if (typeof mod.saveSettings === 'function') {
                await mod.saveSettings();
                savedImmediately = true;
            }
        } catch (err) {
            console.debug('[ImageEmbed] Immediate save unavailable; using debounced save.', err);
        }
        if (!savedImmediately) save();
        // Short delay if saved directly; longer to let the debounced write flush.
        setTimeout(() => location.reload(), savedImmediately ? 200 : 1200);
    });
}

function bindUi() {
    bindEnabledControl();
    bindControl('ie_allowRepeats', 'allowRepeats', { checkbox: true });
    bindControl('ie_scope', 'scope');
    bindControl('ie_triggerMode', 'triggerMode');
    bindControl('ie_matchMethod', 'matchMethod');
    bindControl('ie_triggerChance', 'triggerChance', { number: true });
    bindControl('ie_recentMessages', 'recentMessages', { number: true });
    bindControl('ie_maxImagesInPrompt', 'maxImagesInPrompt', { number: true });
    bindControl('ie_keywordThreshold', 'keywordThreshold', { number: true });

    document.getElementById('ie_add_btn').addEventListener('click', onAddClick);
    document.getElementById('ie_trigger_btn').addEventListener('click', manualTrigger);
    document.getElementById('ie_export_btn').addEventListener('click', exportCollection);

    const importFile = document.getElementById('ie_import_file');
    document.getElementById('ie_import_btn').addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
        if (importFile.files?.[0]) {
            await importCollection(importFile.files[0]);
            importFile.value = '';
        }
    });
}

/* -------------------------------------------------------------------------- */
/*  Wand (extensions) menu button                                             */
/* -------------------------------------------------------------------------- */

function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('ie_wand_button')) return;
    const button = document.createElement('div');
    button.id = 'ie_wand_button';
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.tabIndex = 0;
    button.innerHTML = '<div class="fa-solid fa-image extensionsMenuExtensionButton"></div><span>Pick scene image</span>';
    button.addEventListener('click', manualTrigger);
    menu.appendChild(button);
}

/* -------------------------------------------------------------------------- */
/*  Slash command                                                              */
/* -------------------------------------------------------------------------- */

async function registerSlashCommand() {
    try {
        const { SlashCommandParser } = await import('../../../slash-commands/SlashCommandParser.js');
        const { SlashCommand } = await import('../../../slash-commands/SlashCommand.js');
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'embedimage',
            callback: async () => { await manualTrigger(); return ''; },
            helpString: 'Pick a stored image that fits the current scene and attach it to the latest message.',
        }));
    } catch (err) {
        console.debug('[ImageEmbed] Slash command registration skipped.', err);
    }
}

/* -------------------------------------------------------------------------- */
/*  Init                                                                       */
/* -------------------------------------------------------------------------- */

jQuery(async () => {
    getSettings();

    $('#extensions_settings').append(settingsHtml);
    bindUi();
    renderGallery();
    addWandButton();
    registerSlashCommand();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // Refresh the gallery so scope-bound collections stay in sync.
        renderGallery();
    });

    console.log('[ImageEmbed] Extension loaded.');
});
