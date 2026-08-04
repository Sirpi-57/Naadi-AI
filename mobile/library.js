/* ════════════════════════════════════════════════════════════════
   NAADI AI — LIBRARY (library.js)
   The "Library" bottom tab is not a new screen — it is a segmented
   switcher over the two screens that already exist:

        [ Study Material | Revision Notes ]

   This mirrors exactly how the Practice Hub folds Arena / PYQ Vault /
   AIR Rankings behind one tab (see hubSwitcherHtml() in practice-hub.js),
   and reuses the same .ph-switch / .ph-switch-pill CSS so there is no
   new UI vocabulary to learn.

   Implementation note: the switcher is rendered into a *sibling* div
   that sits above each view's content container in app.html. That way
   study-material.js and revision-notes.js keep rendering into their own
   containers exactly as before — neither file needs to know the switcher
   exists, and re-renders can't blow it away.

   Deep screens (study-chapters, pdf-reader, notebook-detail) do NOT show
   the switcher — you're inside a chapter, not choosing a section.
   ════════════════════════════════════════════════════════════════ */

function libNotebookCount() {
    try { if (typeof notesState !== 'undefined' && notesState.notebooks) return notesState.notebooks.length; } catch (_) { }
    try { return parseInt(localStorage.getItem('NAADI_NB_COUNT') || '', 10) || 0; } catch (_) { return 0; }
}

function libSwitcherHtml(active) {
    const nbCount = libNotebookCount();
    const badge = (key) => (key === 'notes' && nbCount > 0)
        ? ` <span class="lib-pill-badge">${nbCount}</span>` : '';
    const pill = (key, view, icon, label) => `
        <button class="ph-switch-pill ${active === key ? 'active' : ''}"
            onclick="${active === key ? '' : `navigate('${view}')`}">
            <i class="fa-solid ${icon}"></i> ${label}${badge(key)}
        </button>`;
    return `<div class="ph-switch" role="tablist">
        ${pill('material', 'study-material', 'fa-book-open', 'Study Material')}
        ${pill('notes', 'revision-notes', 'fa-note-sticky', 'Revision Notes')}
    </div>`;
}

/**
 * Paints the switcher into the holder above the active Library view.
 * @param {'material'|'notes'} active
 */
function mountLibrarySwitcher(active) {
    const holderId = active === 'notes' ? 'lib-switch-notes' : 'lib-switch-material';
    const holder = document.getElementById(holderId);
    if (holder) holder.innerHTML = libSwitcherHtml(active);
}

// The Library tab always opens on Study Material.
function openLibrary() {
    navigate('study-material');
}