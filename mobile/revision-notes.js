/* ════════════════════════════════════════════════════════════════
   NAADI AI — REVISION NOTES (mobile)  revision-notes.js
   Notebook grid, notebook detail (notes list), note CRUD, the shared
   note-composer bottom sheet (also used by the PDF reader's "Add
   Note"), and Capacitor-appropriate "Download Notebook" PDF export.

   Contracts (verified against backend.py — do not rename fields):
     GET  /api/notes/notebooks                → { notebooks: [...] }
     POST /api/notes/notebooks                { title, type:"custom" }
                                              (400 once at the 6 limit)
     GET  /api/notes/notebooks/<id>           → { notebook, notes }
                                              (notes pre-sorted starred-
                                               first then newest — do NOT
                                               re-sort client-side)
     POST /api/notes/notebooks/<id>           { action:"delete" }  — also
                                              deletes every note inside
     POST /api/notes/add                      { notebook_id, content,
                                                annotation?, color_tag,
                                                is_starred?, source_chapter?,
                                                source_page? }
     POST /api/notes/<note_id>                { action:"delete" } |
                                              { action:"star", is_starred } |
                                              { action:"edit", content,
                                                annotation?, color_tag? }

   Export (spec §6): desktop's window.print() does NOT work in a
   Capacitor WebView, and navigator.share() isn't implemented in the
   Android System WebView — so export is: jsPDF (pure JS, CDN, no
   native code) → @capacitor/filesystem writeFile → @capacitor/share
   native share sheet. Those two are the ONLY approved native plugins.
   Requires shared.js + practice-hub.js (phOpenSheet/phCloseSheet).
   ════════════════════════════════════════════════════════════════ */

// ── STATE ─────────────────────────────────────────────────────────
const notesState = {
    notebooks: null,            // cached /api/notes/notebooks list
    currentNotebookId: null,
    currentNotebook: null,
    currentNotes: [],
    _exporting: false,
};

const NOTEBOOK_LIMIT = 6;       // mirrors the server-side cap

const NOTE_TAGS = ['general', 'definition', 'formula', 'example', 'important'];
const NOTE_TAG_META = {
    general: { label: 'General', icon: 'fa-pen', hex: '#94a3b8' },
    definition: { label: 'Definition', icon: 'fa-book', hex: '#2f6cb3' },
    formula: { label: 'Formula', icon: 'fa-square-root-variable', hex: '#0f6f8c' },
    example: { label: 'Example', icon: 'fa-lightbulb', hex: '#c07c12' },
    important: { label: 'Important', icon: 'fa-circle-exclamation', hex: '#c43d3d' },
};

// ── Tiny once-only CDN script loader (shared with study-material.js) ──
const _ndScriptCache = {};
function loadScriptOnce(url) {
    if (_ndScriptCache[url]) return _ndScriptCache[url];
    _ndScriptCache[url] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = () => resolve();
        s.onerror = () => { delete _ndScriptCache[url]; reject(new Error('Could not load ' + url)); };
        document.head.appendChild(s);
    });
    return _ndScriptCache[url];
}

async function fetchNotebooks(force = false) {
    if (!notesState.notebooks || force) {
        const data = await apiCall('/api/notes/notebooks');
        notesState.notebooks = data.notebooks || [];
        // Cache the count so the Library switcher can badge the Revision
        // Notes pill without its own fetch (frontend only — no backend).
        try { localStorage.setItem('NAADI_NB_COUNT', String(notesState.notebooks.length)); } catch (_) { }
    }
    return notesState.notebooks;
}

// ════════════════════════════════════════════════════════════════
// NOTEBOOK GRID  (view-revision-notes)
// ════════════════════════════════════════════════════════════════
async function loadRevisionNotes() {
    const container = document.getElementById('revision-notes-content');
    container.innerHTML = `<div class="m-picker-wrap">
        <div class="loading-spinner"><div class="spinner"></div> Loading notebooks...</div></div>`;
    try {
        const notebooks = await fetchNotebooks(true);
        const atLimit = notebooks.length >= NOTEBOOK_LIMIT;

        const cards = notebooks.map((nb, i) => {
            const nid = String(nb.notebook_id).replace(/'/g, "\\'");
            const count = nb.notes_count || 0;
            return `<div class="nb-card spine-${(i % 6) + 1}" style="animation-delay:${(0.04 + i * 0.05).toFixed(2)}s" onclick="navigate('notebook-detail', {notebook_id:'${nid}'})">
                <div class="nb-card-top">
                    <div class="nb-card-icon"><i class="fa-solid fa-book"></i></div>
                    <i class="fa-solid fa-chevron-right nb-card-go"></i>
                </div>
                <h4>${escapeHtml(nb.title || 'Untitled')}</h4>
                <p><i class="fa-solid fa-note-sticky"></i> ${count} note${count !== 1 ? 's' : ''}</p>
            </div>`;
        }).join('');

        // Rule 2: hide the create affordance at the limit and show a
        // clear "you're at the limit" moment instead of a raw 400.
        const addDelay = (0.04 + notebooks.length * 0.05).toFixed(2);
        const addTile = atLimit
            ? `<div class="nb-card add-new disabled" style="animation-delay:${addDelay}s">
                <div class="nb-card-top"><div class="nb-card-icon"><i class="fa-solid fa-lock"></i></div></div>
                <h4>Notebook limit reached</h4>
                <p>All ${NOTEBOOK_LIMIT} notebooks in use. Delete one to make room.</p>
            </div>`
            : `<div class="nb-card add-new" style="animation-delay:${addDelay}s" onclick="openCreateNotebookSheet()">
                <div class="nb-card-top"><div class="nb-card-icon"><i class="fa-solid fa-plus"></i></div></div>
                <h4>New Notebook</h4>
                <p>Create a fresh notebook</p>
            </div>`;

        container.innerHTML = `<div class="m-picker-wrap">
            <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin-bottom:16px;">
                <div>
                    <h2 style="font-family:var(--font-display);font-size:1.3rem;font-weight:800;">Revision Notes</h2>
                    <p style="color:var(--s500);font-size:.82rem;margin-top:3px;">Your personal NEET notebooks.</p>
                </div>
                <span class="nb-count-pill ${atLimit ? 'full' : ''}">${notebooks.length}/${NOTEBOOK_LIMIT} notebooks</span>
            </div>
            ${notebooks.length === 0 ? `
                <div class="empty-state" style="margin-bottom:14px;"><i class="fa-solid fa-book"></i>
                    <h3>No notebooks yet</h3>
                    <p style="margin-top:8px;color:var(--s500);">Create your first notebook, or add a note from inside a Study Material chapter.</p>
                </div>` : ''}
            <div class="nb-grid">${cards}${addTile}</div>
        </div>`;
    } catch (e) {
        container.innerHTML = `<div class="m-picker-wrap">
            <div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>
            <h3>Could not load notebooks</h3><p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p>
            <button class="btn btn-outline" style="margin-top:16px;min-height:44px;" onclick="loadRevisionNotes()">
                <i class="fa-solid fa-rotate-right"></i> Retry</button></div></div>`;
    }
}

// ── Create notebook (bottom sheet) ──────────────────────────────
// onCreated(notebookId) is optional — used by the note composer's
// "create one first" flow from inside the PDF reader.
function openCreateNotebookSheet(onCreated) {
    const count = (notesState.notebooks || []).length;
    if (count >= NOTEBOOK_LIMIT) {
        ndToast(`You're at the ${NOTEBOOK_LIMIT}-notebook limit — delete one to make room.`, 'warning');
        return;
    }
    window._nbCreateCallback = onCreated || null;
    phOpenSheet(`
        <div class="ph-sheet-handle"></div>
        <h3 class="ph-sheet-title"><i class="fa-solid fa-book-medical"></i> New Notebook</h3>
        <p class="ph-sheet-sub">${count}/${NOTEBOOK_LIMIT} notebooks used.</p>
        <input type="text" class="nb-input" id="nb-create-title" maxlength="60"
            placeholder="Notebook title (e.g. Human Physiology)" autocomplete="off">
        <button class="btn ph-start-btn" style="margin-top:14px;" onclick="submitCreateNotebook()">
            <i class="fa-solid fa-check"></i> Create Notebook</button>
    `);
    setTimeout(() => document.getElementById('nb-create-title')?.focus(), 250);
}

async function submitCreateNotebook() {
    const input = document.getElementById('nb-create-title');
    const title = (input?.value || '').trim();
    if (!title) { ndToast('Give your notebook a title first.', 'warning'); return; }
    try {
        const res = await apiCall('/api/notes/notebooks', 'POST', { title, type: 'custom' });
        phCloseSheet();
        ndToast('Notebook created ✓', 'success');
        await fetchNotebooks(true);
        const cb = window._nbCreateCallback;
        window._nbCreateCallback = null;
        if (cb) cb(res.notebook_id);
        else if (document.getElementById('view-revision-notes').classList.contains('active')) {
            loadRevisionNotes();
        }
    } catch (e) {
        // Server enforces the cap too (400 "Maximum 6 notebooks allowed")
        // — surface it as a friendly message, never a raw error dump.
        if (/maximum|6 notebooks/i.test(e.message)) {
            phCloseSheet();
            ndToast(`You're at the ${NOTEBOOK_LIMIT}-notebook limit — delete one to make room.`, 'warning', 3400);
            fetchNotebooks(true).then(() => {
                if (document.getElementById('view-revision-notes').classList.contains('active')) loadRevisionNotes();
            });
        } else {
            ndToast('Could not create notebook: ' + e.message, 'error');
        }
    }
}

// ── Delete notebook (explicit confirm — notes go with it) ───────
function confirmDeleteNotebook(notebookId, title, notesCount) {
    const nid = String(notebookId).replace(/'/g, "\\'");
    phOpenSheet(`
        <div class="ph-sheet-handle"></div>
        <h3 class="ph-sheet-title"><i class="fa-solid fa-triangle-exclamation" style="color:var(--red);"></i> Delete "${escapeHtml(title)}"?</h3>
        <p class="ph-sheet-sub">This permanently deletes the notebook <b>and all ${notesCount} note${notesCount !== 1 ? 's' : ''} inside it</b>. This cannot be undone.</p>
        <div style="display:flex;gap:10px;margin-top:14px;">
            <button class="btn btn-outline" style="flex:1;min-height:48px;" onclick="phCloseSheet()">Keep it</button>
            <button class="btn ph-start-btn danger" style="flex:1;margin-top:0;" onclick="deleteNotebook('${nid}')">
                <i class="fa-solid fa-trash"></i> Delete all</button>
        </div>
    `);
}

async function deleteNotebook(notebookId) {
    try {
        await apiCall(`/api/notes/notebooks/${notebookId}`, 'POST', { action: 'delete' });
        phCloseSheet();
        ndToast('Notebook deleted.', 'success');
        await fetchNotebooks(true);
        navigate('revision-notes');
    } catch (e) {
        ndToast('Could not delete: ' + e.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════════
// NOTEBOOK DETAIL  (view-notebook-detail)
// Backend already returns notes starred-first then newest — render
// in the order received, no client-side re-sorting.
// ════════════════════════════════════════════════════════════════
async function loadNotebookDetail(notebookId) {
    notesState.currentNotebookId = notebookId;
    const container = document.getElementById('notebook-detail-content');
    container.innerHTML = `<div class="m-picker-wrap">
        <div class="loading-spinner"><div class="spinner"></div> Opening notebook...</div></div>`;
    try {
        const data = await apiCall(`/api/notes/notebooks/${notebookId}`);
        if (data && data.error) throw new Error(data.error);
        notesState.currentNotebook = data.notebook || {};
        notesState.currentNotes = data.notes || [];
        renderNotebookDetail();
    } catch (e) {
        container.innerHTML = `<div class="m-picker-wrap">
            <button class="btn btn-outline btn-sm" style="margin-bottom:14px;min-height:44px;"
                onclick="navigate('revision-notes')"><i class="fa-solid fa-arrow-left"></i> Back</button>
            <div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>
            <h3>Could not open notebook</h3><p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p></div></div>`;
    }
}

function noteSourceChipHtml(note) {
    if (!note.source_chapter) return '';
    const pg = note.source_page ? ` · p.${note.source_page}` : '';
    return `<span class="nb-note-source"><i class="fa-solid fa-file-pdf"></i> From PDF${pg}</span>`;
}

function noteEntryHtml(note) {
    const tag = NOTE_TAG_META[note.color_tag] ? note.color_tag : 'general';
    const meta = NOTE_TAG_META[tag];
    const nid = String(note.note_id).replace(/'/g, "\\'");
    return `<div class="nb-note-entry tag-${tag} ${note.is_starred ? 'is-starred' : ''}" id="note-${escapeHtml(String(note.note_id))}">
        <div class="nb-note-topline">
            <span class="nb-tag-chip" style="--tag:${meta.hex};"><i class="fa-solid ${meta.icon}"></i> ${meta.label}</span>
            ${noteSourceChipHtml(note)}
            ${note.is_starred ? '<i class="fa-solid fa-star nb-star-ind"></i>' : ''}
        </div>
        <div class="nb-note-text">${escapeHtml(note.content || '')}</div>
        ${note.annotation ? `<div class="nb-note-annotation"><i class="fa-solid fa-pen-nib"></i> ${escapeHtml(note.annotation)}</div>` : ''}
        <div class="nb-note-actions">
            <button onclick="toggleNoteStar('${nid}', ${note.is_starred ? 'false' : 'true'})" aria-label="Star note">
                <i class="fa-${note.is_starred ? 'solid' : 'regular'} fa-star"></i></button>
            <button onclick="openNoteEditor('${nid}')" aria-label="Edit note"><i class="fa-solid fa-pen"></i></button>
            <button class="danger" onclick="confirmDeleteNote('${nid}')" aria-label="Delete note"><i class="fa-solid fa-trash"></i></button>
        </div>
    </div>`;
}

function renderNotebookDetail() {
    const container = document.getElementById('notebook-detail-content');
    const nb = notesState.currentNotebook || {};
    const notes = notesState.currentNotes || [];
    const nid = String(notesState.currentNotebookId).replace(/'/g, "\\'");
    const starredCount = notes.filter(n => n.is_starred).length;

    container.innerHTML = `<div class="m-picker-wrap">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
            <button class="btn btn-outline btn-sm" style="min-height:44px;"
                onclick="navigate('revision-notes')"><i class="fa-solid fa-arrow-left"></i> Back</button>
            <div style="flex:1;"></div>
            <button class="nb-download-btn" id="nb-export-btn"
                onclick="exportNotebookPdf()"><i class="fa-solid fa-file-arrow-down"></i> Download</button>
            <button class="btn btn-outline btn-sm danger-outline" style="min-height:44px;"
                onclick="confirmDeleteNotebook('${nid}', '${escapeHtml(nb.title || 'Untitled').replace(/'/g, "\\'")}', ${notes.length})">
                <i class="fa-solid fa-trash"></i></button>
        </div>

        <div class="nb-page">
            <div class="nb-page-header">
                <h2>${escapeHtml(nb.title || 'Untitled')}</h2>
                <p>${notes.length} note${notes.length !== 1 ? 's' : ''}${starredCount ? ` · ${starredCount} starred` : ''}</p>
            </div>
            <div class="nb-page-body">
                ${notes.length === 0
            ? `<div class="nb-empty">This notebook is empty — add your first note below, or save one from a Study Material chapter.</div>`
            : notes.map(noteEntryHtml).join('')}
                <button class="nb-add-note-inline" onclick="openNoteComposer({ notebookId: '${nid}' })">
                    <i class="fa-solid fa-plus"></i> Add a note
                </button>
            </div>
        </div>
    </div>`;
}

// ── Note actions ─────────────────────────────────────────────────
async function toggleNoteStar(noteId, makeStarred) {
    try {
        await apiCall(`/api/notes/${noteId}`, 'POST', { action: 'star', is_starred: makeStarred });
        await loadNotebookDetail(notesState.currentNotebookId); // re-fetch: backend re-sorts starred-first
    } catch (e) {
        ndToast('Could not update star: ' + e.message, 'error');
    }
}

function confirmDeleteNote(noteId) {
    const nid = String(noteId).replace(/'/g, "\\'");
    phOpenSheet(`
        <div class="ph-sheet-handle"></div>
        <h3 class="ph-sheet-title"><i class="fa-solid fa-trash" style="color:var(--red);"></i> Delete this note?</h3>
        <p class="ph-sheet-sub">This can't be undone.</p>
        <div style="display:flex;gap:10px;margin-top:14px;">
            <button class="btn btn-outline" style="flex:1;min-height:48px;" onclick="phCloseSheet()">Cancel</button>
            <button class="btn ph-start-btn danger" style="flex:1;margin-top:0;" onclick="deleteNote('${nid}')">
                <i class="fa-solid fa-trash"></i> Delete</button>
        </div>
    `);
}

async function deleteNote(noteId) {
    try {
        await apiCall(`/api/notes/${noteId}`, 'POST', { action: 'delete' });
        phCloseSheet();
        // Fade/collapse the note out before the list re-renders.
        const el = document.getElementById('note-' + noteId);
        if (el) { el.classList.add('nb-note-removing'); await new Promise(r => setTimeout(r, 200)); }
        ndToast('Note deleted.', 'success');
        loadNotebookDetail(notesState.currentNotebookId);
    } catch (e) {
        ndToast('Could not delete note: ' + e.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════════
// NOTE COMPOSER — shared bottom sheet.
// Used BOTH from a notebook (notebookId fixed, source fields null)
// and from the PDF reader (notebook picked from the user's list,
// source_chapter/source_page set). Same POST /api/notes/add either
// way — there is deliberately NO auto-create-per-chapter behavior:
// if the user has no notebooks yet, they're prompted to create one
// first (rule 3).
//
// opts: { notebookId?, sourceChapter?, sourcePage?, prefill?, onSaved? }
// ════════════════════════════════════════════════════════════════
const _composer = { opts: null, tag: 'general', starred: false, notebookId: null };

async function openNoteComposer(opts = {}) {
    _composer.opts = opts;
    _composer.tag = 'general';
    _composer.starred = false;
    _composer.notebookId = opts.notebookId || null;

    let notebooks = [];
    try { notebooks = await fetchNotebooks(); }
    catch (e) { ndToast('Could not load notebooks: ' + e.message, 'error'); return; }

    // No notebooks yet and none pre-selected → create one first (rule 3).
    if (!opts.notebookId && notebooks.length === 0) {
        phOpenSheet(`
            <div class="ph-sheet-handle"></div>
            <h3 class="ph-sheet-title"><i class="fa-solid fa-book"></i> You need a notebook first</h3>
            <p class="ph-sheet-sub">Notes always live inside a notebook. Create your first one, then this note will be saved into it.</p>
            <button class="btn ph-start-btn" onclick="phCloseSheet(); openCreateNotebookSheet((newId) => openNoteComposer(Object.assign({}, window._pendingComposerOpts, { notebookId: newId })));">
                <i class="fa-solid fa-plus"></i> Create a notebook</button>
        `);
        window._pendingComposerOpts = opts;
        return;
    }
    if (!_composer.notebookId) _composer.notebookId = notebooks[0].notebook_id;

    const pickerHtml = opts.notebookId
        ? '' // fixed notebook (composing from inside that notebook)
        : `<label class="nb-composer-label">Save to notebook</label>
           <div class="ph-fchip-row" id="nb-picker-row">
            ${notebooks.map(nb => {
            const id = String(nb.notebook_id).replace(/'/g, "\\'");
            return `<button class="ph-fchip sm ${nb.notebook_id === _composer.notebookId ? 'active' : ''}"
                    data-nbid="${escapeHtml(String(nb.notebook_id))}"
                    onclick="pickComposerNotebook('${id}', this)">${escapeHtml(nb.title || 'Untitled')}</button>`;
        }).join('')}
           </div>`;

    const tagChips = NOTE_TAGS.map(t => {
        const m = NOTE_TAG_META[t];
        return `<button class="nb-tag-pick ${t === _composer.tag ? 'active' : ''}" data-tag="${t}"
            style="--tag:${m.hex};" onclick="pickComposerTag('${t}', this)">
            <i class="fa-solid ${m.icon}"></i> ${m.label}</button>`;
    }).join('');

    const sourceLine = opts.sourceChapter
        ? `<p class="ph-sheet-sub" style="margin-bottom:8px;"><i class="fa-solid fa-file-pdf"></i>
            Linked to this chapter · page ${opts.sourcePage}</p>` : '';

    phOpenSheet(`
        <div class="ph-sheet-handle"></div>
        <h3 class="ph-sheet-title"><i class="fa-solid fa-note-sticky"></i> New Note</h3>
        ${sourceLine}
        ${pickerHtml}
        <label class="nb-composer-label">Note</label>
        <textarea class="nb-input" id="nb-note-content" rows="4"
            placeholder="Write your note...">${escapeHtml(opts.prefill || '')}</textarea>
        <label class="nb-composer-label">Personal annotation <span>(optional)</span></label>
        <input type="text" class="nb-input" id="nb-note-annotation" maxlength="200"
            placeholder="Why this matters / memory hook" autocomplete="off">
        <label class="nb-composer-label">Tag</label>
        <div class="ph-fchip-row">${tagChips}</div>
        <button class="nb-star-toggle" id="nb-star-toggle" onclick="toggleComposerStar(this)">
            <i class="fa-regular fa-star"></i> Star this note</button>
        <button class="btn ph-start-btn" style="margin-top:12px;" id="nb-note-save" onclick="submitComposerNote()">
            <i class="fa-solid fa-check"></i> Save Note</button>
    `);
}

function pickComposerNotebook(id, btn) {
    _composer.notebookId = id;
    document.querySelectorAll('#nb-picker-row .ph-fchip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}
function pickComposerTag(tag, btn) {
    _composer.tag = tag;
    document.querySelectorAll('.nb-tag-pick').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}
function toggleComposerStar(btn) {
    _composer.starred = !_composer.starred;
    btn.classList.toggle('on', _composer.starred);
    btn.innerHTML = `<i class="fa-${_composer.starred ? 'solid' : 'regular'} fa-star"></i> ${_composer.starred ? 'Starred' : 'Star this note'}`;
}

function buildAddNotePayload(composer, contentValue, annotationValue) {
    const payload = {
        notebook_id: composer.notebookId,
        content: contentValue,
        color_tag: composer.tag,
        is_starred: composer.starred,
        // Same endpoint whether the note comes from the PDF reader
        // (source fields set) or from inside a notebook (both null).
        source_chapter: (composer.opts && composer.opts.sourceChapter) || null,
        source_page: (composer.opts && composer.opts.sourcePage) || null,
    };
    const ann = (annotationValue || '').trim();
    if (ann) payload.annotation = ann;
    return payload;
}

async function submitComposerNote() {
    const content = (document.getElementById('nb-note-content')?.value || '').trim();
    if (!content) { ndToast('Write something first.', 'warning'); return; }
    if (!_composer.notebookId) { ndToast('Pick a notebook first.', 'warning'); return; }
    const btn = document.getElementById('nb-note-save');
    if (btn) btn.disabled = true;
    try {
        const payload = buildAddNotePayload(_composer, content,
            document.getElementById('nb-note-annotation')?.value);
        await apiCall('/api/notes/add', 'POST', payload);
        // Saving a note earns the study day.
        if (typeof pingStreak === 'function') pingStreak('note_saved');
        phCloseSheet();
        ndToast('Note saved ✓', 'success');
        fetchNotebooks(true); // refresh counts in the background
        const onSaved = _composer.opts && _composer.opts.onSaved;
        if (onSaved) onSaved();
        else if (document.getElementById('view-notebook-detail').classList.contains('active')) {
            loadNotebookDetail(notesState.currentNotebookId);
        }
    } catch (e) {
        if (btn) btn.disabled = false;
        ndToast('Could not save note: ' + e.message, 'error');
    }
}

// ── Edit note (prefilled sheet → action:"edit") ──────────────────
const _editor = { noteId: null, tag: 'general' };

function openNoteEditor(noteId) {
    const note = (notesState.currentNotes || []).find(n => String(n.note_id) === String(noteId));
    if (!note) return;
    _editor.noteId = noteId;
    _editor.tag = NOTE_TAG_META[note.color_tag] ? note.color_tag : 'general';

    const tagChips = NOTE_TAGS.map(t => {
        const m = NOTE_TAG_META[t];
        return `<button class="nb-tag-pick ${t === _editor.tag ? 'active' : ''}"
            style="--tag:${m.hex};" onclick="_editor.tag='${t}';document.querySelectorAll('.nb-tag-pick').forEach(b=>b.classList.remove('active'));this.classList.add('active');">
            <i class="fa-solid ${m.icon}"></i> ${m.label}</button>`;
    }).join('');

    phOpenSheet(`
        <div class="ph-sheet-handle"></div>
        <h3 class="ph-sheet-title"><i class="fa-solid fa-pen"></i> Edit Note</h3>
        <label class="nb-composer-label">Note</label>
        <textarea class="nb-input" id="nb-edit-content" rows="4">${escapeHtml(note.content || '')}</textarea>
        <label class="nb-composer-label">Personal annotation <span>(optional)</span></label>
        <input type="text" class="nb-input" id="nb-edit-annotation" maxlength="200"
            value="${escapeHtml(note.annotation || '')}" autocomplete="off">
        <label class="nb-composer-label">Tag</label>
        <div class="ph-fchip-row">${tagChips}</div>
        <button class="btn ph-start-btn" style="margin-top:14px;" onclick="submitNoteEdit()">
            <i class="fa-solid fa-check"></i> Save Changes</button>
    `);
}

async function submitNoteEdit() {
    const content = (document.getElementById('nb-edit-content')?.value || '').trim();
    if (!content) { ndToast('A note needs some content.', 'warning'); return; }
    try {
        await apiCall(`/api/notes/${_editor.noteId}`, 'POST', {
            action: 'edit',
            content,
            annotation: (document.getElementById('nb-edit-annotation')?.value || '').trim(),
            color_tag: _editor.tag,
        });
        phCloseSheet();
        ndToast('Note updated ✓', 'success');
        loadNotebookDetail(notesState.currentNotebookId);
    } catch (e) {
        ndToast('Could not update note: ' + e.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════════
// "DOWNLOAD NOTEBOOK" — Capacitor-appropriate export (spec §6).
//   1. jsPDF (CDN, pure JS) recreates the desktop template: title
//      header, ruled notebook page, per-note tag color bar, content,
//      annotation, star indicator.
//   2. @capacitor/filesystem writes the PDF (base64 → Directory.Cache).
//   3. @capacitor/share opens Android's native share sheet.
// Feature-detected: plain browsers (LAN testing) get a blob download;
// a native build missing the plugins gets a clear toast, never a raw
// JS error.
// ════════════════════════════════════════════════════════════════
async function exportNotebookPdf() {
    if (notesState._exporting) return;
    const nb = notesState.currentNotebook || {};
    const notes = notesState.currentNotes || [];
    if (notes.length === 0) { ndToast('This notebook has no notes to export yet.', 'info'); return; }

    notesState._exporting = true;
    const btn = document.getElementById('nb-export-btn');
    if (btn) btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div> Building...';

    try {
        await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
        if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('PDF library failed to load (check internet).');

        const doc = buildNotebookPdfDoc(window.jspdf.jsPDF, nb, notes);
        const fileName = `NAADI_${(nb.title || 'Notebook').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'Notebook'}.pdf`;
        await deliverPdf(doc, fileName, nb.title || 'Notebook');
    } catch (e) {
        ndToast('Export failed: ' + e.message, 'error', 3400);
    }
    notesState._exporting = false;
    if (btn) btn.innerHTML = '<i class="fa-solid fa-file-arrow-down"></i> Download';
}

// Pure PDF construction — desktop template recreated: header, ruled
// paper, tag color bars, content, annotation aside, star indicator.
function buildNotebookPdfDoc(JsPDF, nb, notes) {
    const doc = new JsPDF({ unit: 'pt', format: 'a4' });
    const W = 595.28, H = 841.89;
    const MX = 52, TOP = 64, BOTTOM = 60;
    let y = TOP;
    let pageNo = 1;

    const ruledPage = () => {
        doc.setFillColor(253, 252, 248);            // warm paper
        doc.rect(0, 0, W, H, 'F');
        doc.setDrawColor(226, 232, 240);            // faint rule lines
        doc.setLineWidth(0.5);
        for (let ly = TOP + 8; ly < H - BOTTOM; ly += 26) {
            doc.line(MX - 14, ly, W - MX + 14, ly);
        }
        doc.setDrawColor(196, 61, 61);              // red margin line
        doc.setLineWidth(0.75);
        doc.line(MX - 20, 0, MX - 20, H);
        // footer
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(148, 163, 184);
        doc.text('NAADI AI · Revision Notes', MX - 14, H - 28);
        doc.text(`Page ${pageNo}`, W - MX, H - 28, { align: 'right' });
    };

    const newPage = () => { doc.addPage(); pageNo += 1; ruledPage(); y = TOP; };
    const ensure = (need) => { if (y + need > H - BOTTOM) newPage(); };

    ruledPage();

    // ── Title header ──
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(15, 23, 42);
    doc.text(nb.title || 'Notebook', MX, y);
    y += 20;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(100, 116, 139);
    const starred = notes.filter(n => n.is_starred).length;
    doc.text(`${notes.length} note${notes.length !== 1 ? 's' : ''}${starred ? ` · ${starred} starred` : ''} · exported ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`, MX, y);
    y += 10;
    doc.setDrawColor(31, 88, 150);
    doc.setLineWidth(1.4);
    doc.line(MX, y, W - MX, y);
    y += 24;

    const hexToRgb = (hex) => {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex) || [];
        return [parseInt(m[1] || '94', 16), parseInt(m[2] || 'a3', 16), parseInt(m[3] || 'b8', 16)];
    };

    notes.forEach((note) => {
        const meta = NOTE_TAG_META[note.color_tag] || NOTE_TAG_META.general;
        const [tr, tg, tb] = hexToRgb(meta.hex);
        const contentW = W - MX * 2 - 26;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        const contentLines = doc.splitTextToSize(String(note.content || ''), contentW);
        doc.setFontSize(9);
        const annLines = note.annotation
            ? doc.splitTextToSize('Annotation: ' + String(note.annotation), contentW - 10) : [];

        const blockH = 26 + contentLines.length * 14.5
            + (annLines.length ? annLines.length * 11.5 + 16 : 0) + 14;
        ensure(Math.min(blockH, H - TOP - BOTTOM)); // very long notes still start on a fresh page

        const blockTop = y - 12;

        // Card background + tag color bar (star tint like desktop)
        if (note.is_starred) doc.setFillColor(255, 252, 230);
        else doc.setFillColor(255, 255, 255);
        doc.setDrawColor(226, 232, 240);
        doc.setLineWidth(0.6);
        doc.roundedRect(MX - 6, blockTop, W - MX * 2 + 12, blockH - 6, 5, 5, 'FD');
        doc.setFillColor(tr, tg, tb);
        doc.rect(MX - 6, blockTop, 4, blockH - 6, 'F');

        // Tag label + star indicator
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(tr, tg, tb);
        doc.text(meta.label.toUpperCase(), MX + 8, y);
        if (note.is_starred) {
            doc.setFillColor(192, 124, 18);
            doc.circle(MX + 8 + doc.getTextWidth(meta.label.toUpperCase()) + 10, y - 2.4, 2.6, 'F');
            doc.setTextColor(192, 124, 18);
            doc.text('STARRED', MX + 8 + doc.getTextWidth(meta.label.toUpperCase()) + 17, y);
        }
        if (note.source_chapter) {
            doc.setTextColor(148, 163, 184);
            doc.setFont('helvetica', 'normal');
            doc.text(`from PDF${note.source_page ? ' · p.' + note.source_page : ''}`, W - MX - 2, y, { align: 'right' });
        }
        y += 15;

        // Content — pagination-aware line by line
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        doc.setTextColor(30, 41, 59);
        contentLines.forEach(line => {
            ensure(16);
            doc.text(line, MX + 8, y);
            y += 14.5;
        });

        // Annotation aside
        if (annLines.length) {
            y += 4;
            doc.setFont('helvetica', 'italic');
            doc.setFontSize(9);
            doc.setTextColor(100, 116, 139);
            annLines.forEach(line => {
                ensure(14);
                doc.text(line, MX + 14, y);
                y += 11.5;
            });
        }
        y += 20;
    });

    return doc;
}

async function deliverPdf(doc, fileName, title) {
    const cap = window.Capacitor;
    const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

    // ── Best path on a real device: Capacitor Filesystem + Share ──
    const Filesystem = cap && cap.Plugins && cap.Plugins.Filesystem;
    const Share = cap && cap.Plugins && cap.Plugins.Share;
    if (isNative && Filesystem && Share) {
        const base64 = doc.output('datauristring').split(',')[1];
        const write = await Filesystem.writeFile({
            path: `naadi-exports/${fileName}`, data: base64,
            directory: 'CACHE', recursive: true,
        });
        let uri = write && write.uri;
        if (!uri) {
            const got = await Filesystem.getUri({ path: `naadi-exports/${fileName}`, directory: 'CACHE' });
            uri = got.uri;
        }
        await Share.share({
            title: `${title} — NAADI Revision Notes`,
            dialogTitle: 'Share notebook PDF',
            files: [uri],
        });
        ndToast('PDF ready — pick where to save or share it.', 'success', 3200);
        return;
    }

    // ── Frontend-only fallbacks (no native plugins required) ──
    // These cover the native build BEFORE `cap sync`, and plain browsers.

    // 1) Web Share with a file — modern Android WebViews open the system
    //    save/share sheet. This is the reliable no-plugin path on-device.
    try {
        const blob = doc.output('blob');
        const file = new File([blob], fileName, { type: 'application/pdf' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: `${title} — NAADI Revision Notes` });
            ndToast('PDF ready — pick where to save or share it.', 'success', 3000);
            return;
        }
    } catch (e) {
        if (e && e.name === 'AbortError') return; // user dismissed the sheet — not an error
        // otherwise fall through to the next method
    }

    // 2) Blob-URL anchor download — works in browsers and WebViews that
    //    have a download manager wired up.
    try {
        const blob = doc.output('blob');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fileName; a.rel = 'noopener';
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
        ndToast('PDF downloaded ✓', 'success');
        return;
    } catch (_) { /* fall through */ }

    // 3) Last resort — open the PDF so it can be saved from the viewer.
    try {
        doc.output('dataurlnewwindow');
        ndToast('Opened your PDF — use the viewer to save or share it.', 'info', 3600);
    } catch (_) {
        ndToast('Could not export on this device. Try updating the app.', 'error', 3600);
    }
}

console.log('Revision Notes (mobile) module loaded ✅');