/* ════════════════════════════════════════════════════════════════
   NAADI AI — MOBILE SHARED MODULE (shared.js)
   Firebase config + auth init, API_BASE host detection, and the
   apiCall() helper with the exact auto-retry-once-on-401 behaviour
   from the desktop app.html. Load AFTER the Firebase compat SDKs.
   ════════════════════════════════════════════════════════════════ */

// ════════════════════════════════════════════════════════════════
// NEET EXAM DATE — used by the Home screen countdown chip.
// NTA has not announced the date at time of writing, so this is null
// and the countdown chip simply does not render. Set it to an ISO
// date string (interpreted as 00:00 IST) the day NTA announces:
//     const NEET_EXAM_DATE = '2026-05-03';
// ════════════════════════════════════════════════════════════════
const NEET_EXAM_DATE = null;

// ── Firebase (same project + SDK pattern as desktop login.html) ──
const firebaseConfig = {
    apiKey: "AIzaSyARmJ3T_oczTxeLsaOHCg2I0tQpasoqpkI",
    authDomain: "naadi-ai-ec3ed.firebaseapp.com",
    projectId: "naadi-ai-ec3ed",
    storageBucket: "naadi-ai-ec3ed.firebasestorage.app",
    messagingSenderId: "358604151888",
    appId: "1:358604151888:web:9e94cf78ed91f29ca18555"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// ════════════════════════════════════════════════════════════════
// API_BASE — auto-detect backend URL
// (copy of the desktop app.html logic, plus two mobile additions)
// ════════════════════════════════════════════════════════════════
//
// PROD_API_BASE: the deployed https:// backend URL. This is what a
// Capacitor-wrapped build (which serves the UI from its own local
// WebView origin, NOT from your Flask server) will call.
//
// DEV OVERRIDE: for testing an installed app against a Flask server
// running on your computer, open the app's WebView console and run:
//     localStorage.setItem('NAADI_API_BASE', 'http://192.168.1.42:5000')
// (use YOUR computer's LAN IP — see TESTING_GUIDE.md Part C.)
// Remove it with localStorage.removeItem('NAADI_API_BASE').
const PROD_API_BASE = ''; // ← set to e.g. 'https://api.naadi.ai' when the backend is deployed

const API_BASE = (() => {
    // 0. Explicit dev override (device testing against a local backend)
    const override = localStorage.getItem('NAADI_API_BASE');
    if (override) {
        console.log('API_BASE override →', override);
        return override;
    }

    const proto = window.location.protocol;
    const host = window.location.hostname;
    const port = window.location.port;

    // 1. Running inside a Capacitor WebView (capacitor:// on iOS,
    //    http(s)://localhost served by Capacitor on Android).
    //    "localhost" here is the PHONE, not your computer — so we
    //    must use the deployed backend (or the override above).
    if (window.Capacitor || proto === 'capacitor:') {
        console.log('Capacitor detected → API_BASE =', PROD_API_BASE || '(unset — set PROD_API_BASE or the NAADI_API_BASE override)');
        return PROD_API_BASE;
    }

    // 2. Served from the backend itself (port 5000) → relative paths
    if (port === '5000') return '';

    // 3. Local dev (Live Server 5500, python http.server, file://, …)
    if (host === 'localhost' || host === '127.0.0.1' || host === '') {
        console.log('Backend detected at localhost:5000');
        return 'http://localhost:5000';
    }

    // 4. Phone-browser test over LAN: page served from the computer's
    //    LAN IP (e.g. http://192.168.1.42:8000) → backend is the same
    //    machine on port 5000.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return `http://${host}:5000`;
    }

    // 5. GitHub Codespaces support (same as desktop)
    if (host.includes('github.dev') || host.includes('gitpod.io')) {
        return window.location.origin.replace(/-\d+\./, '-5000.');
    }

    return '';
})();
console.log('API_BASE =', API_BASE);

// ── Auth token state ──
let currentUser = null;
let idToken = null;

async function getToken() {
    if (currentUser) {
        idToken = await currentUser.getIdToken(true);
    }
    return idToken;
}

// ════════════════════════════════════════════════════════════════
// apiCall — identical retry semantics to the desktop app.html:
// on a 401, wait for auth, force-refresh the token, wait 1s, and
// retry the request exactly once.
// ════════════════════════════════════════════════════════════════
async function apiCall(endpoint, method = 'GET', body = null, _retried = false) {
    const token = await getToken();
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${API_BASE}${endpoint}`, opts);

    // Auto-retry ONCE on 401 with a fresh token
    if (res.status === 401 && !_retried) {
        console.warn('Got 401, refreshing token and retrying...');
        // Wait for auth to be ready
        if (!auth.currentUser) {
            await new Promise((resolve) => {
                const unsub = auth.onAuthStateChanged(user => {
                    if (user) { unsub(); resolve(); }
                });
                setTimeout(resolve, 5000);
            });
        }
        if (auth.currentUser) {
            idToken = await auth.currentUser.getIdToken(true);
            currentUser = auth.currentUser;
            // Small delay to ensure token is fresh
            await new Promise(resolve => setTimeout(resolve, 1000));
            return apiCall(endpoint, method, body, true); // retry once
        }
    }

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}

// ════════════════════════════════════════════════════════════════
// STREAK PING — fire-and-forget.
// A streak day is earned by DOING something, never by merely opening
// the app. Qualifying actions (one is enough for the day):
//     • completing a Concept Studio block      → source: 'studio_block'
//     • submitting an OPD / Arena / PYQ test    → source: 'test_submit'
//     • saving a revision note                  → source: 'note_saved'
//     • opening a Study Material chapter        → source: 'study_read'
// The day boundary is IST (Asia/Kolkata), computed server-side — a
// 1 AM study session must not break the chain.
//
// Never awaited, never throws, never blocks the UI. If it fails the
// student loses a streak day, not their work.
// ════════════════════════════════════════════════════════════════
function pingStreak(source) {
    apiCall('/api/streak/ping', 'POST', { source: source || 'unknown' })
        .then((res) => {
            // Live-update the Home streak chip if Home is mounted.
            const el = document.getElementById('hm-streak-count');
            if (el && typeof res.current === 'number') {
                el.textContent = res.current;
                document.getElementById('hm-streak-chip')?.classList.toggle('live', res.current > 0);
            }
            // Keep the cached Home payload honest for the next visit.
            if (typeof homeState !== 'undefined' && homeState.data?.streak) {
                homeState.data.streak.current = res.current;
            }
        })
        .catch(() => { /* streak is cosmetic — never surface an error */ });
}

// ── Toast (same .nd-toast classes as the desktop modal system) ──
function ndToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 2600;
    let holder = document.getElementById('nd-toast-container');
    if (!holder) {
        holder = document.createElement('div');
        holder.id = 'nd-toast-container';
        document.body.appendChild(holder);
    }
    const toast = document.createElement('div');
    toast.className = 'nd-toast ' + type;
    toast.textContent = message;
    holder.appendChild(toast);
    setTimeout(function () {
        toast.classList.add('fade-out');
        setTimeout(function () { toast.remove(); }, 260);
    }, duration);
}

// ── Small HTML helpers shared by concept-studio.js ──
function safeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&times;/g, '×').replace(/&divide;/g, '÷')
        .replace(/&alpha;/g, 'α').replace(/&beta;/g, 'β').replace(/&gamma;/g, 'γ')
        .replace(/&delta;/g, 'δ').replace(/&mu;/g, 'μ').replace(/&lambda;/g, 'λ')
        .replace(/&Omega;/g, 'Ω').replace(/&plusmn;/g, '±').replace(/&deg;/g, '°')
        .replace(/&infin;/g, '∞').replace(/&sup2;/g, '²').replace(/&sup3;/g, '³')
        .replace(/&frac12;/g, '½').replace(/&rArr;/g, '⇒').replace(/&hArr;/g, '⇔')
        .replace(/&rarr;/g, '→').replace(/&larr;/g, '←');
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}