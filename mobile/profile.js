/* ════════════════════════════════════════════════════════════════
   NAADI AI — PROFILE (profile.js)
   ─────────────────────────────────────────────────────────────────
   The Profile view inside app.html. Reached from the badge in the
   top-right of the shell top bar. No sixth tab: the bottom nav stays
   at five (Home · Studio · OPD · Arena · Library).

   Everything here is optional and fillable later. Nothing on this
   screen blocks studying.

   Writes:
     • users/{uid}                       ← via POST /api/user/account/save
     • app_reviews/{uid}                 ← via POST /api/user/review
     • Storage: avatars/{uid}/avatar.jpg ← client-side, then photo_url saved

   Auth-only operations (password) go straight to Firebase Auth, never
   through the backend. A password is never sent to our server.

   Requires: shared.js (auth, apiCall, ndToast, escapeHtml),
             firebase-storage-compat (loaded in app.html).
   ════════════════════════════════════════════════════════════════ */

// ════════════════════════════════════════════════════════════════
// STORE LINKS — fill these in when the listings go live. Until then
// a 4- or 5-star review is still recorded; the student simply is not
// sent to a page that does not exist.
// ════════════════════════════════════════════════════════════════
const PLAY_STORE_URL = '';   // e.g. 'https://play.google.com/store/apps/details?id=ai.naadi.app'
const APP_STORE_URL = '';   // e.g. 'https://apps.apple.com/app/id0000000000'

const AVATAR_MAX_PX = 512;   // avatars are downscaled before upload
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const pfState = {
  user: {},        // last payload from /api/user/account
  dirty: new Set(),
  saving: false,
  stars: 0,
  uploading: false,
};

const CLASS_LEVELS = [
  ['11', 'Class 11'],
  ['12', 'Class 12'],
  ['dropper', 'Dropper'],
];

const ATTEMPTS = [
  ['1', '1st'],
  ['2', '2nd'],
  ['3', '3rd'],
  ['4+', '4th +'],
];

// ════════════════════════════════════════════════════════════════
// ENTRY — called by navigate('profile')
// ════════════════════════════════════════════════════════════════
async function loadProfile() {
  const el = document.getElementById('profile-content');
  if (!el) return;

  el.innerHTML = `<div class="loading-spinner" style="padding:40px 20px;">
        <div class="spinner"></div> Loading your profile...</div>`;

  try {
    pfState.user = await apiCall('/api/user/account');
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="margin:24px 16px;">
            <i class="fa-solid fa-circle-exclamation"></i>
            <h3>Couldn't load your profile</h3>
            <p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p>
            <button class="btn btn-outline" style="margin-top:16px;min-height:44px;"
                onclick="loadProfile()">Try again</button>
        </div>`;
    return;
  }

  pfState.dirty.clear();
  pfState.stars = Number(pfState.user.app_review_stars || 0);
  el.innerHTML = pfHtml(pfState.user);
  pfLoadParentLinks();
  pfPaintStars();
}

// ════════════════════════════════════════════════════════════════
// MARKUP
// ════════════════════════════════════════════════════════════════
function pfHtml(u) {
  const name = u.name || 'Student';
  const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  const plan = (u.subscription && u.subscription.plan) || 'free';

  return `
    <div class="pf-wrap">

      <!-- ── Hero ─────────────────────────────────────────────── -->
      <div class="pf-hero">
        <button class="pf-avatar-btn" onclick="pfPickAvatar()" aria-label="Change photo">
          ${u.photo_url
      ? `<img id="pf-avatar-img" src="${escapeHtml(u.photo_url)}" alt="">`
      : `<div class="pf-avatar-initials" id="pf-avatar-img">${escapeHtml(initials || 'S')}</div>`}
          <span class="pf-avatar-edit"><i class="fa-solid fa-camera"></i></span>
        </button>
        <input type="file" id="pf-avatar-input" accept="image/*" hidden onchange="pfUploadAvatar(this)">

        <div class="pf-hero-name">Dr. ${escapeHtml(name)}</div>
        <div class="pf-hero-mail">${escapeHtml(u.email || '')}</div>
        <div class="pf-hero-chips">
          <span class="pf-hero-chip"><i class="fa-solid fa-id-badge"></i>
            ${plan === 'free' ? 'Free plan' : escapeHtml(plan)}</span>
          ${u.neet_target_year ? `<span class="pf-hero-chip">
            <i class="fa-solid fa-bullseye"></i> NEET ${escapeHtml(String(u.neet_target_year))}</span>` : ''}
        </div>
        <div class="pf-upload-bar" id="pf-upload-bar" style="display:none;"></div>
      </div>

      <!-- ══ LEFT COLUMN (desktop): all the fillable details ══
           On phones .pf-col is display:contents, so these wrappers are
           invisible to layout — the cards stack exactly as they did
           before. The two-column split only exists at ≥1024px. -->
      <div class="pf-col pf-col-main">

      <!-- ── Identity ─────────────────────────────────────────── -->
      <div class="pf-card">
        <div class="pf-card-head">
          <div class="pf-card-ico"><i class="fa-solid fa-user"></i></div>
          <div class="pf-card-title">You</div>
        </div>

        <div class="pf-field">
          <label class="pf-label" for="pf-name">Full name</label>
          <input class="pf-input" id="pf-name" maxlength="80" value="${escapeHtml(u.name || '')}"
                 oninput="pfTouch('name')">
        </div>

        <div class="pf-field">
          <label class="pf-label" for="pf-email">Email</label>
          <input class="pf-input" id="pf-email" value="${escapeHtml(u.email || '')}" readonly>
          <p class="pf-hint">This is the address you log in with, so it can't be changed here.
             Write to us if you need it moved.</p>
        </div>

        <div class="pf-field">
          <button class="pf-btn pf-btn-quiet" onclick="pfOpenPassword()">
            <i class="fa-solid fa-lock"></i> Change password
          </button>
        </div>
      </div>

      <!-- ── Guardian ─────────────────────────────────────────── -->
      <div class="pf-card">
        <div class="pf-card-head">
          <div class="pf-card-ico"><i class="fa-solid fa-user-shield"></i></div>
          <div class="pf-card-title">Parent or guardian</div>
        </div>
        <p class="pf-card-note">Used only to send progress updates. We never share it.</p>

        <div class="pf-field">
          <label class="pf-label" for="pf-gname">Name</label>
          <input class="pf-input" id="pf-gname" maxlength="80" value="${escapeHtml(u.guardian_name || '')}"
                 oninput="pfTouch('guardian_name')">
        </div>

        <div class="pf-field">
          <label class="pf-label" for="pf-gphone">Phone</label>
          <input class="pf-input" id="pf-gphone" type="tel" inputmode="tel" maxlength="15"
                 value="${escapeHtml(u.guardian_phone || '')}" oninput="pfTouch('guardian_phone')">
        </div>

        <div class="pf-field">
          <label class="pf-label" for="pf-gmail">Email</label>
          <input class="pf-input" id="pf-gmail" type="email" inputmode="email"
                 value="${escapeHtml(u.guardian_email || '')}" oninput="pfTouch('guardian_email')">
        </div>
      </div>

      <!-- ── Parent access (invite) ───────────────────────────── -->
      <div class="pf-card">
        <div class="pf-card-head">
          <div class="pf-card-ico"><i class="fa-solid fa-envelope-circle-check"></i></div>
          <div class="pf-card-title">Parent access</div>
        </div>
        <p class="pf-card-note">Invite your parent to follow your progress. They'll get an
           email to set up their own login. You can turn this off any time.</p>

        <div id="pf-parent-links"></div>

        <div class="pf-field">
          <label class="pf-label" for="pf-invite-email">Parent's email</label>
          <input class="pf-input" id="pf-invite-email" type="email" inputmode="email"
                 placeholder="parent@example.com" value="${escapeHtml(u.guardian_email || '')}">
        </div>

        <button type="button" class="pf-btn" id="pf-invite-btn" onclick="pfInviteParent()">
          <i class="fa-solid fa-paper-plane"></i> Send invite
        </button>
      </div>

      <!-- ── School ───────────────────────────────────────────── -->
      <div class="pf-card">
        <div class="pf-card-head">
          <div class="pf-card-ico"><i class="fa-solid fa-school"></i></div>
          <div class="pf-card-title">School</div>
        </div>
        <p class="pf-card-note">Both codes come from your school. The school code finds your school;
           the section code puts you in the right teacher's dashboard.</p>

        <div class="pf-field">
          <label class="pf-label" for="pf-school">School code</label>
          <input class="pf-input" id="pf-school" maxlength="32" placeholder="e.g. NAADI-CHN-014"
                 value="${escapeHtml(u.school_id || '')}" oninput="pfTouch('school_id')">
        </div>

        <div class="pf-field">
          <label class="pf-label" for="pf-classid">Section code</label>
          <input class="pf-input" id="pf-classid" maxlength="32" placeholder="e.g. 12-A"
                 value="${escapeHtml(u.class_id || '')}" oninput="pfTouch('class_id')">
        </div>

        <div class="pf-field">
          <label class="pf-label" for="pf-roll">Roll number</label>
          <input class="pf-input" id="pf-roll" maxlength="16" placeholder="e.g. 24"
                 value="${escapeHtml(u.roll_no || '')}" oninput="pfTouch('roll_no')">
          <p class="pf-hint">The number your school uses for you on the class
             register. Your teacher's class report is sorted by it.</p>
        </div>

        <div class="pf-field">
          <label class="pf-label">Year</label>
          <div class="pf-seg" id="pf-seg-class">
            ${CLASS_LEVELS.map(([v, l]) => `
              <button type="button" data-v="${v}"
                class="${String(u.class_level || '') === v ? 'on' : ''}"
                onclick="pfSeg('pf-seg-class','class_level','${v}')">${l}</button>`).join('')}
          </div>
        </div>
      </div>

      <!-- ── NEET ─────────────────────────────────────────────── -->
      <div class="pf-card">
        <div class="pf-card-head">
          <div class="pf-card-ico"><i class="fa-solid fa-bullseye"></i></div>
          <div class="pf-card-title">Your NEET</div>
        </div>

        <div class="pf-row">
          <div class="pf-field">
            <label class="pf-label" for="pf-year">Target year</label>
            <input class="pf-input" id="pf-year" type="number" inputmode="numeric"
                   min="2026" max="2040" placeholder="2027"
                   value="${escapeHtml(String(u.neet_target_year || ''))}"
                   oninput="pfTouch('neet_target_year')">
          </div>
          <div class="pf-field">
            <label class="pf-label" for="pf-score">Target score</label>
            <input class="pf-input" id="pf-score" type="number" inputmode="numeric"
                   min="0" max="720" placeholder="/ 720"
                   value="${escapeHtml(String(u.neet_target_score || ''))}"
                   oninput="pfTouch('neet_target_score')">
          </div>
        </div>

        <div class="pf-field">
          <label class="pf-label" for="pf-college">Dream college</label>
          <input class="pf-input" id="pf-college" maxlength="120" placeholder="AIIMS Delhi, CMC Vellore…"
                 value="${escapeHtml(u.dream_college || '')}" oninput="pfTouch('dream_college')">
        </div>

        <div class="pf-field">
          <label class="pf-label">Which attempt is this?</label>
          <div class="pf-seg" id="pf-seg-attempt">
            ${ATTEMPTS.map(([v, l]) => `
              <button type="button" data-v="${v}"
                class="${String(u.neet_attempt_number || '') === v ? 'on' : ''}"
                onclick="pfSeg('pf-seg-attempt','neet_attempt_number','${v}')">${l}</button>`).join('')}
          </div>
        </div>

        <div class="pf-field">
          <label class="pf-label" for="pf-hall">Hall ticket number</label>
          <input class="pf-input" id="pf-hall" maxlength="24" placeholder="Add it when NTA issues it"
                 value="${escapeHtml(u.neet_hall_ticket || '')}" oninput="pfTouch('neet_hall_ticket')">
          <p class="pf-hint">Adding it lets us count your result among NAADI students. Leave it blank until
             your admit card arrives.</p>
        </div>
      </div>

      <!-- ── Plan ─────────────────────────────────────────────── -->
      <div class="pf-card">
        <div class="pf-card-head">
          <div class="pf-card-ico"><i class="fa-solid fa-crown"></i></div>
          <div class="pf-card-title">Plan</div>
        </div>
        <p class="pf-card-note">You're on the <strong>${plan === 'free' ? 'free' : escapeHtml(plan)}</strong>
           plan. Paid plans open when payments go live — nothing you've studied is affected.</p>
        <button class="pf-btn pf-btn-quiet" disabled>
          <i class="fa-solid fa-clock"></i> Payments coming soon
        </button>
      </div>
      </div><!-- /.pf-col-main -->

      <!-- ══ RIGHT COLUMN (desktop): query on top, review below ══
           DOM order stays Support → Review so mobile is untouched; the
           desktop layer flips them visually (Review on top). -->
      <div class="pf-col pf-col-side">

      <!-- ── Help & Support ───────────────────────────────────── -->
      <!-- The conversation itself moved to Doubts, which is now the one
           place every conversation lives. This card stays because Profile
           is where people look for help — it just points at the new home
           instead of opening a second copy of it. -->
      <div class="pf-card">
        <div class="pf-card-head">
          <div class="pf-card-ico"><i class="fa-solid fa-headset"></i></div>
          <div class="pf-card-title">Help &amp; Support</div>
        </div>
        <p class="pf-card-note">Stuck on something? Found a bug? Chat with the
           NAADI team in Doubts — a real person replies, and your whole
           conversation stays in one place.</p>
        <button class="pf-btn pf-btn-primary" onclick="pfSupportOpen()">
          <i class="fa-solid fa-comments"></i> Open Doubts
        </button>
      </div>

      <!-- ── Review ───────────────────────────────────────────── -->
      <div class="pf-card">
        <div class="pf-card-head">
          <div class="pf-card-ico"><i class="fa-solid fa-star"></i></div>
          <div class="pf-card-title">Rate NAADI</div>
        </div>
        <p class="pf-card-note">Tell us honestly. We read every one of these.</p>

        <div class="pf-stars" id="pf-stars" role="radiogroup" aria-label="Rating">
          ${[1, 2, 3, 4, 5].map(n => `
            <button type="button" class="pf-star" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}"
              onclick="pfSetStars(${n})">★</button>`).join('')}
        </div>

        <div class="pf-field">
          <label class="pf-label" for="pf-review">What worked, what didn't</label>
          <textarea class="pf-input" id="pf-review" rows="3" maxlength="600"
            placeholder="Optional">${escapeHtml(pfState.user.app_review_text || '')}</textarea>
        </div>

        <div class="pf-field">
          <button class="pf-btn pf-btn-primary" id="pf-review-btn" onclick="pfSendReview()" disabled>
            <i class="fa-solid fa-paper-plane"></i> Send review
          </button>
        </div>
      </div>
      </div><!-- /.pf-col-side -->

      <!-- ══ Actions — desktop: sits at the foot of the left column ══ -->
      <div class="pf-col pf-col-actions">

      <!-- ── Actions ──────────────────────────────────────────── -->
      <div class="pf-card">
        <div class="pf-field" style="margin-top:0;">
          <button class="pf-btn pf-btn-quiet" onclick="pfReplayTour()">
            <i class="fa-solid fa-compass"></i> Take the tour again
          </button>
        </div>
        <div class="pf-field">
          <button class="pf-btn pf-btn-quiet" onclick="handleLogout()">
            <i class="fa-solid fa-right-from-bracket"></i> Log out
          </button>
        </div>
      </div>
      </div><!-- /.pf-col-actions -->

    </div>

    <!-- ── Sticky save bar ────────────────────────────────────── -->
    <div class="pf-savebar" id="pf-savebar">
      <button class="pf-btn pf-btn-primary" id="pf-save-btn" onclick="pfSave()">
        <i class="fa-solid fa-check"></i> <span id="pf-save-label">Save changes</span>
      </button>
    </div>

    <!-- ── Password sheet ─────────────────────────────────────── -->
    <div class="pf-modal" id="pf-pw-modal" onclick="if(event.target===this)pfClosePassword()">
      <div class="pf-sheet">
        <div class="pf-sheet-title">Change password</div>
        <div class="pf-sheet-sub">For your safety, confirm the password you use now before setting a new one.</div>

        <div class="pf-field">
          <label class="pf-label" for="pf-pw-old">Current password</label>
          <input class="pf-input" id="pf-pw-old" type="password" autocomplete="current-password">
        </div>
        <div class="pf-field">
          <label class="pf-label" for="pf-pw-new">New password</label>
          <input class="pf-input" id="pf-pw-new" type="password" minlength="6" autocomplete="new-password"
                 placeholder="At least 6 characters">
        </div>
        <div class="pf-field">
          <label class="pf-label" for="pf-pw-new2">Repeat new password</label>
          <input class="pf-input" id="pf-pw-new2" type="password" minlength="6" autocomplete="new-password">
        </div>

        <div class="pf-sheet-actions">
          <button class="pf-btn pf-btn-quiet" onclick="pfClosePassword()">Cancel</button>
          <button class="pf-btn pf-btn-primary" id="pf-pw-btn" onclick="pfChangePassword()">Update password</button>
        </div>
      </div>
    </div>`;
}

// ── Parent invite ──────────────────────────────────────────────────
async function pfInviteParent() {
  const input = document.getElementById('pf-invite-email');
  const btn = document.getElementById('pf-invite-btn');
  const email = (input.value || '').trim();

  if (!email || !email.includes('@') || !email.includes('.')) {
    ndToast('Enter a valid email address.', 'error');
    return;
  }

  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…';

  try {
    const res = await apiCall('/api/student/parent/invite', 'POST', { email });
    if (res.status === 'already_linked') {
      ndToast('That parent is already linked.', 'success');
    } else {
      ndToast('Invite sent! Ask them to check their email.', 'success');
    }
    await pfLoadParentLinks();
  } catch (e) {
    ndToast(e.message || 'Could not send the invite.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

async function pfLoadParentLinks() {
  const box = document.getElementById('pf-parent-links');
  if (!box) return;

  let d;
  try {
    d = await apiCall('/api/student/parent/links');
  } catch (e) {
    box.innerHTML = '';
    return;
  }

  const parents = d.parents || [];
  const pending = d.pending_invites || [];

  let html = '';

  for (const p of parents) {
    html += `
          <div class="pf-linkrow">
            <div>
              <div class="pf-linkrow-t">${escapeHtml(p.name || 'Parent')}</div>
              <div class="pf-linkrow-s">${escapeHtml(p.email || '')} · linked</div>
            </div>
            <button type="button" class="pf-linkrow-x"
                    onclick="pfUnlinkParent('${escapeHtml(p.uid)}')">Remove</button>
          </div>`;
  }

  for (const i of pending) {
    html += `
          <div class="pf-linkrow">
            <div>
              <div class="pf-linkrow-t">${escapeHtml(i.email || '')}</div>
              <div class="pf-linkrow-s">invite sent · waiting for them to accept</div>
            </div>
          </div>`;
  }

  if (parents.length) {
    html += `
          <div class="pf-field" style="margin-top:12px">
            <label class="pf-toggle">
              <input type="checkbox" id="pf-consent" ${d.parent_consent ? 'checked' : ''}
                     onchange="pfSetConsent(this.checked)">
              <span>Let my parent see my progress</span>
            </label>
          </div>`;
  }

  box.innerHTML = html;
}

async function pfSetConsent(allow) {
  try {
    await apiCall('/api/student/parent/consent', 'POST', { allow });
    ndToast(allow ? 'Parent access on.' : 'Parent access paused.', 'success');
  } catch (e) {
    ndToast(e.message || 'Could not update.', 'error');
  }
}

async function pfUnlinkParent(uid) {
  try {
    await apiCall('/api/student/parent/unlink', 'POST', { parent_uid: uid });
    ndToast('Parent removed.', 'success');
    await pfLoadParentLinks();
  } catch (e) {
    ndToast(e.message || 'Could not remove.', 'error');
  }
}

// ════════════════════════════════════════════════════════════════
// DIRTY TRACKING
// ════════════════════════════════════════════════════════════════
function pfTouch(field) {
  pfState.dirty.add(field);
  document.getElementById('pf-savebar')?.classList.add('up');
}

function pfSeg(segId, field, value) {
  const seg = document.getElementById(segId);
  if (!seg) return;
  seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === value));
  pfState.user[field] = value;
  pfTouch(field);
}

// ════════════════════════════════════════════════════════════════
// SAVE
// ════════════════════════════════════════════════════════════════
const PF_INPUTS = {
  name: 'pf-name',
  guardian_name: 'pf-gname',
  guardian_phone: 'pf-gphone',
  guardian_email: 'pf-gmail',
  school_id: 'pf-school',
  class_id: 'pf-classid',
  roll_no: 'pf-roll',
  neet_target_year: 'pf-year',
  neet_target_score: 'pf-score',
  dream_college: 'pf-college',
  neet_hall_ticket: 'pf-hall',
};

const PF_NUMERIC = ['neet_target_year', 'neet_target_score'];

async function pfSave() {
  if (pfState.saving || !pfState.dirty.size) return;

  const payload = {};
  for (const field of pfState.dirty) {
    if (PF_INPUTS[field]) {
      const raw = (document.getElementById(PF_INPUTS[field])?.value || '').trim();
      if (PF_NUMERIC.includes(field)) {
        if (raw === '') { payload[field] = null; continue; }
        if (isNaN(Number(raw))) {
          ndToast('Check the number in ' + field.replace(/_/g, ' '), 'error');
          return;
        }
        payload[field] = Number(raw);
      } else {
        payload[field] = raw;
      }
    } else {
      // segmented controls already wrote into pfState.user
      payload[field] = pfState.user[field];
    }
  }

  if (payload.neet_target_score != null &&
    (payload.neet_target_score < 0 || payload.neet_target_score > 720)) {
    ndToast('A NEET score sits between 0 and 720.', 'error');
    return;
  }

  pfState.saving = true;
  const btn = document.getElementById('pf-save-btn');
  btn.disabled = true;
  document.getElementById('pf-save-label').textContent = 'Saving…';

  try {
    await apiCall('/api/user/account/save', 'POST', payload);

    // Keep Firebase Auth's displayName in step with the profile, so
    // the Home greeting and the onboarding nameplate stay correct.
    if (payload.name && auth.currentUser) {
      await auth.currentUser.updateProfile({ displayName: payload.name });
    }

    Object.assign(pfState.user, payload);
    pfState.dirty.clear();
    document.getElementById('pf-savebar').classList.remove('up');
    ndToast('Profile saved', 'success');

    // Repaint the hero (name / target-year chip may have changed).
    loadProfile();
  } catch (e) {
    ndToast(e.message || "Couldn't save. Try again.", 'error');
  } finally {
    pfState.saving = false;
    if (btn) btn.disabled = false;
    const lbl = document.getElementById('pf-save-label');
    if (lbl) lbl.textContent = 'Save changes';
  }
}

// ════════════════════════════════════════════════════════════════
// AVATAR — downscale on the device, then upload. A phone photo is
// 4 MB; an avatar needs 40 KB. The student's data plan pays for the
// difference, so we resize before it leaves the phone.
// ════════════════════════════════════════════════════════════════
function pfPickAvatar() {
  document.getElementById('pf-avatar-input')?.click();
}

async function pfUploadAvatar(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || pfState.uploading) return;

  if (!file.type.startsWith('image/')) {
    ndToast('Pick an image file.', 'error');
    return;
  }
  if (file.size > AVATAR_MAX_BYTES) {
    ndToast('That image is over 5 MB. Pick a smaller one.', 'error');
    return;
  }

  const bar = document.getElementById('pf-upload-bar');
  pfState.uploading = true;
  bar.style.display = '';
  bar.textContent = 'Preparing photo…';

  try {
    const blob = await pfResizeImage(file, AVATAR_MAX_PX);
    const uid = auth.currentUser.uid;
    const ref = firebase.storage().ref(`avatars/${uid}/avatar.jpg`);

    const task = ref.put(blob, { contentType: 'image/jpeg', cacheControl: 'public,max-age=86400' });
    await new Promise((resolve, reject) => {
      task.on('state_changed',
        snap => {
          const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
          bar.textContent = `Uploading… ${pct}%`;
        },
        reject, resolve);
    });

    const url = await ref.getDownloadURL();
    await apiCall('/api/user/account/save', 'POST', { photo_url: url });
    pfState.user.photo_url = url;

    bar.textContent = '';
    bar.style.display = 'none';
    ndToast('Photo updated', 'success');
    loadProfile();
  } catch (e) {
    bar.style.display = 'none';
    const msg = /unauthorized|permission/i.test(e.message || '')
      ? 'Storage rejected the upload. Check the Storage rules for avatars/{uid}/.'
      : (e.message || "Couldn't upload the photo.");
    ndToast(msg, 'error');
  } finally {
    pfState.uploading = false;
  }
}

function pfResizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not read that image.')),
        'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

// ════════════════════════════════════════════════════════════════
// PASSWORD — Firebase Auth requires a recent login before a password
// change, so we re-authenticate with the current password first. The
// password never touches our backend.
// ════════════════════════════════════════════════════════════════
function pfOpenPassword() {
  document.getElementById('pf-pw-modal').classList.add('open');
  setTimeout(() => document.getElementById('pf-pw-old')?.focus(), 150);
}

function pfClosePassword() {
  const m = document.getElementById('pf-pw-modal');
  if (!m) return;
  m.classList.remove('open');
  ['pf-pw-old', 'pf-pw-new', 'pf-pw-new2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

async function pfChangePassword() {
  const oldPw = document.getElementById('pf-pw-old').value;
  const newPw = document.getElementById('pf-pw-new').value;
  const newPw2 = document.getElementById('pf-pw-new2').value;

  if (!oldPw) { ndToast('Enter your current password.', 'error'); return; }
  if (newPw.length < 6) { ndToast('The new password needs at least 6 characters.', 'error'); return; }
  if (newPw !== newPw2) { ndToast("The two new passwords don't match.", 'error'); return; }
  if (newPw === oldPw) { ndToast('The new password is the same as the old one.', 'error'); return; }

  const btn = document.getElementById('pf-pw-btn');
  btn.disabled = true;

  try {
    const user = auth.currentUser;
    const cred = firebase.auth.EmailAuthProvider.credential(user.email, oldPw);
    await user.reauthenticateWithCredential(cred);
    await user.updatePassword(newPw);
    pfClosePassword();
    ndToast('Password updated', 'success');
  } catch (e) {
    const map = {
      'auth/wrong-password': 'That current password is not right.',
      'auth/invalid-credential': 'That current password is not right.',
      'auth/weak-password': 'Pick a stronger password.',
      'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
      'auth/network-request-failed': 'No connection. Check your internet.',
    };
    ndToast(map[e.code] || e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ════════════════════════════════════════════════════════════════
// REVIEW
// ════════════════════════════════════════════════════════════════
function pfSetStars(n) {
  pfState.stars = n;
  pfPaintStars();
}

function pfPaintStars() {
  document.querySelectorAll('.pf-star').forEach(el => {
    el.classList.toggle('on', Number(el.dataset.n) <= pfState.stars);
    el.setAttribute('aria-checked', Number(el.dataset.n) === pfState.stars ? 'true' : 'false');
  });
  const btn = document.getElementById('pf-review-btn');
  if (btn) btn.disabled = pfState.stars === 0;
}

function pfStoreUrl() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return APP_STORE_URL;
  if (/Android/i.test(ua)) return PLAY_STORE_URL;
  return PLAY_STORE_URL || APP_STORE_URL;
}

async function loadParentSection() {
  const d = await apiCall('/api/student/parent/links');

  document.getElementById('pf-parent').innerHTML = `
      <div class="pf-section-title">Parent access</div>

      ${d.parents.map(p => `
        <div class="pf-row">
          <div>
            <div class="pf-row-t">${escapeHtml(p.name)}</div>
            <div class="pf-row-s">${escapeHtml(p.email)}</div>
          </div>
          <button onclick="unlinkParent('${p.uid}')">Remove</button>
        </div>`).join('')}

      ${d.pending_invites.map(i => `
        <div class="pf-row">
          <div class="pf-row-s">Invite sent to ${escapeHtml(i.email)} — not accepted yet</div>
        </div>`).join('')}

      <div class="pf-row">
        <div>
          <div class="pf-row-t">Let my parent see my progress</div>
          <div class="pf-row-s">You can turn this off at any time.</div>
        </div>
        <label class="pf-switch">
          <input type="checkbox" ${d.parent_consent ? 'checked' : ''}
                 onchange="setConsent(this.checked)">
          <span></span>
        </label>
      </div>

      <button class="btn" onclick="inviteParent()">Invite a parent</button>`;
}

async function inviteParent() {
  const email = prompt("Your parent's email address");
  if (!email) return;
  try {
    await apiCall('/api/student/parent/invite', 'POST', { email });
    ndToast('Invite sent', 'success');
    loadParentSection();
  } catch (e) { ndToast(e.message, 'error'); }
}

async function setConsent(allow) {
  await apiCall('/api/student/parent/consent', 'POST', { allow });
  ndToast(allow ? 'Parent access on' : 'Parent access off', 'info');
}

async function unlinkParent(uid) {
  if (!confirm('Remove this parent’s access?')) return;
  await apiCall('/api/student/parent/unlink', 'POST', { parent_uid: uid });
  loadParentSection();
}

async function pfSendReview() {
  if (!pfState.stars) return;
  const btn = document.getElementById('pf-review-btn');
  btn.disabled = true;

  const text = (document.getElementById('pf-review')?.value || '').trim();

  try {
    await apiCall('/api/user/review', 'POST', { stars: pfState.stars, text: text.slice(0, 600) });
    pfState.user.app_review_stars = pfState.stars;
    pfState.user.app_review_text = text;

    if (pfState.stars >= 4) {
      const url = pfStoreUrl();
      if (url) {
        ndToast('Thank you. Opening the store…', 'success');
        setTimeout(() => window.open(url, '_blank', 'noopener'), 700);
      } else {
        // The listing is not live yet. Say so plainly rather than
        // opening a dead link.
        ndToast("Thank you. We'll ask you to post it publicly once we're on the store.", 'success');
      }
    } else {
      ndToast("Thank you — that's the kind we learn from.", 'success');
    }
  } catch (e) {
    ndToast(e.message || "Couldn't send the review.", 'error');
  } finally {
    btn.disabled = false;
  }
}

// ════════════════════════════════════════════════════════════════
// TOUR REPLAY — read-only: ?replay=1 makes onboarding.js write nothing
// and return to the app on Done.
// ════════════════════════════════════════════════════════════════
function pfReplayTour() {
  window.location.href = 'onboarding.html?replay=1';
}

/* ══════════════════════════════════════════════════════════════════
   NAADI SUPPORT — MOVED

   The chat with the team used to live here as a modal off this screen.
   It now lives in Doubts (doubts.js), which is the one home for every
   conversation: the NAADI team today, class and subject teachers next.
   Same uid-keyed thread, same /api/support/* endpoints, same history —
   only the entry point changed.

   pfSupportOpen() survives as a one-line redirect so the Help & Support
   card, and anything else that ever called it, keeps working.
   ══════════════════════════════════════════════════════════════════ */

function pfSupportOpen() {
  if (typeof navigate === 'function') return navigate('doubts');
  window.location.href = 'app.html#doubts';
}