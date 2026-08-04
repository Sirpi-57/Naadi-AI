/* ════════════════════════════════════════════════════════════════
   NAADI AI — SYSTEM BARS (system-bars.js)
   ─────────────────────────────────────────────────────────────────
   The status bar (clock, battery) and the navigation bar (⦀ ○ ‹) are
   drawn by the OS, outside the WebView. No CSS in this project can
   reach them. This file is the only thing that can.

   In edge-to-edge mode both bars are transparent and the page paints
   underneath them. What is left to decide is the colour of the *icons*
   in each bar, and that depends on what each bar is sitting on top of.
   In NAADI the two ends of the screen frequently disagree:

       onboarding / login    navy on top, navy underneath  → light, light
       app.html              navy .m-topbar on top,
                             white .m-tabbar underneath    → light, dark

   So this cannot be set once at launch. Each page declares what is
   behind its bars and the shim translates.

   ── Usage ─────────────────────────────────────────────────────────
   Load it before any other script, and declare the page on <html>:

       <html lang="en" data-bars="dark">          <!-- both ends dark -->
       <html lang="en" data-bars="dark light">    <!-- top dark, bottom light -->

   Or call it directly when a screen changes inside a single page:

       naadiBars('dark', 'light');

   The values name the BACKGROUND, not the icons. "dark" means the bar
   sits on a dark surface, so the icons must be light. This is the
   opposite of Capacitor's own enum, where SystemBarsStyle.Dark means
   "light content on a dark background" — the translation happens once,
   here, so that no call site in NAADI has to hold that in its head.

   Safe on desktop Chrome and on any page opened outside the app: if
   the Capacitor bridge is absent, every function is a no-op.

   Requires: Capacitor 8.3.0+ (SystemBars is bundled with
   @capacitor/core — there is nothing to install).
   ════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // Capacitor's enum, named after the background rather than the icons:
    //   'DARK'  → light icons, for a dark background
    //   'LIGHT' → dark icons, for a light background
    const STYLE = { dark: 'DARK', light: 'LIGHT', auto: 'DEFAULT' };

    function plugin() {
        // SystemBars ships inside @capacitor/core, so it is registered on
        // the bridge without an import. On the web it simply is not there.
        return window.Capacitor?.Plugins?.SystemBars || null;
    }

    /**
     * @param {'dark'|'light'|'auto'} top     what the STATUS bar sits on
     * @param {'dark'|'light'|'auto'} [bottom] what the NAVIGATION bar sits on
     *                                         (defaults to the same as top)
     */
    function naadiBars(top, bottom) {
        const sb = plugin();
        if (!sb) return;

        const topStyle = STYLE[top] || STYLE.auto;
        const bottomStyle = STYLE[bottom || top] || topStyle;

        // Styled per bar, not globally. Capacitor 8.3.1 separated the two
        // style states; before that, setting one clobbered the other.
        sb.setStyle({ style: topStyle, bar: 'StatusBar' }).catch(noop);
        sb.setStyle({ style: bottomStyle, bar: 'NavigationBar' }).catch(noop);
    }

    function noop() { /* a bar that will not restyle is not worth a crash */ }

    // Read the declaration off <html data-bars="...">, e.g. "dark light".
    function applyDeclared() {
        const decl = (document.documentElement.dataset.bars || '').trim().split(/\s+/);
        if (!decl[0]) return;
        naadiBars(decl[0], decl[1]);
    }

    // Android restores its own bar styling when the app returns from the
    // background, so reassert on resume rather than only at first paint.
    function bind() {
        applyDeclared();
        window.Capacitor?.Plugins?.App?.addListener?.('appStateChange', (s) => {
            if (s.isActive) applyDeclared();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }

    window.naadiBars = naadiBars;
})();