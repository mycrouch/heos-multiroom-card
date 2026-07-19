/*
 * AMP Multi-room Card v1.0.0
 * https://github.com/mycrouch/amp-multiroom-card
 *
 * One-card multi-room audio control for a HEOS group leader (e.g. a Denon AVR):
 * source picker, leader volume, all-rooms volume, and per-room join/volume/
 * play-stop rows. Rooms join via a configurable Home Assistant script (for
 * reliable analogue-source streaming) or plain media_player.join.
 *
 * MIT License — Jason Crouch. Icons: Material Design Icons via ha-icon.
 */

const AMP_CARD_VERSION = '1.0.0';

class AmpMultiroomCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement('amp-multiroom-card-editor');
  }

  static getStubConfig(hass) {
    // Prefer a media_player that supports grouping (bit 524288) and has other
    // grouping-capable siblings to offer as rooms.
    const players = Object.keys(hass.states).filter((e) => e.startsWith('media_player.'));
    const grouping = players.filter(
      (e) => ((hass.states[e].attributes.supported_features || 0) & 524288) !== 0
    );
    const leader = grouping[0] || players[0] || '';
    const rooms = grouping.filter((e) => e !== leader).slice(0, 3);
    return { entity: leader, rooms };
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error('You need to define an entity (the group leader media_player)');
    }
    this._config = config;
    this._rooms = Array.isArray(config.rooms) ? config.rooms : [];
    this._built = false;
    this._errorShown = false;
    this._showSources = false;
    this._dragging = {}; // slider entity -> true while user is dragging
    this._pendingJoin = {}; // room -> timestamp of optimistic UI hold
    this._renderKey = '';
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const leader = hass.states[this._config.entity];
    if (!leader) {
      if (!this._errorShown) {
        this.innerHTML = `<ha-card><div style="padding:16px;">Entity not found: ${this._config.entity}</div></ha-card>`;
        this._errorShown = true;
        this._built = false;
      }
      return;
    }
    this._errorShown = false;
    if (!this._built) {
      this._buildDom();
      this._built = true;
      this._appliedThemeName = undefined;
    }
    const wantTheme = this._config.theme || null;
    const dark = hass.themes && hass.themes.darkMode;
    if (this._appliedThemeName !== wantTheme || this._appliedThemeDark !== dark) {
      this._applyTheme();
      this._appliedThemeName = wantTheme;
      this._appliedThemeDark = dark;
    }
    // Cheap re-render guard: skip patching when nothing we consume changed.
    const key = this._buildRenderKey();
    if (key !== this._renderKey) {
      this._renderKey = key;
      this._updateDynamic();
    }
  }

  _buildRenderKey() {
    const parts = [];
    const push = (id) => {
      const s = this._hass.states[id];
      if (!s) {
        parts.push(`${id}:missing`);
        return;
      }
      const a = s.attributes || {};
      parts.push(
        `${id}:${s.state}:${a.source || ''}:${a.volume_level ?? ''}:${(a.group_members || []).join(',')}`
      );
    };
    push(this._config.entity);
    this._rooms.forEach(push);
    return parts.join('|');
  }

  getCardSize() {
    return 3 + this._rooms.length;
  }

  // --- helpers ---------------------------------------------------------

  _leader() {
    return this._hass.states[this._config.entity];
  }

  _groupMembers() {
    const l = this._leader();
    return (l && l.attributes && l.attributes.group_members) || [];
  }

  _isJoined(room) {
    return this._groupMembers().includes(room);
  }

  _roomName(room) {
    const names = this._config.room_names || {};
    if (names[room]) return names[room];
    const s = this._hass.states[room];
    return (s && s.attributes && s.attributes.friendly_name) || room;
  }

  _sourceList() {
    const l = this._leader();
    const all = (l && l.attributes && l.attributes.source_list) || [];
    const filter = this._config.sources;
    if (Array.isArray(filter) && filter.length) {
      return filter.filter((s) => all.includes(s));
    }
    return all;
  }

  _callService(domain, service, data) {
    this._hass.callService(domain, service, data);
  }

  _joinRoom(room) {
    this._pendingJoin[room] = Date.now();
    const script = this._config.join_script;
    if (script) {
      const name = script.replace(/^script\./, '');
      this._callService('script', name, { room });
    } else {
      this._callService('media_player', 'join', {
        entity_id: this._config.entity,
        group_members: [room],
      });
    }
  }

  _unjoinRoom(room) {
    this._pendingJoin[room] = Date.now();
    this._callService('media_player', 'unjoin', { entity_id: room });
  }

  _setVolume(entityId, pct) {
    this._callService('media_player', 'volume_set', {
      entity_id: entityId,
      volume_level: Math.min(1, Math.max(0, pct / 100)),
    });
  }

  _setGroupVolume(pct) {
    const members = this._groupMembers();
    const targets = members.length ? members : [this._config.entity];
    targets.forEach((e) => this._setVolume(e, pct));
  }

  // Gradient presets shared with mycrouch/gradient-themes.
  static get GRADIENTS() {
    return {
      blue: ['#0d2b45', '#1565c0'],
      sky: ['#0f2f4a', '#039be5'],
      cyan: ['#0b3538', '#00838f'],
      teal: ['#12303d', '#00695c'],
      emerald: ['#0c3524', '#00a86b'],
      green: ['#103316', '#2e7d32'],
      lime: ['#243508', '#7cb342'],
      gold: ['#3d3208', '#f9a825'],
      amber: ['#3a2f0b', '#b28704'],
      orange: ['#3d2208', '#ef6c00'],
      red: ['#3e1a0f', '#e65100'],
      crimson: ['#380d12', '#c62828'],
      pink: ['#3d1027', '#d81b60'],
      magenta: ['#33103a', '#ab29c4'],
      purple: ['#2a1440', '#8e24aa'],
      violet: ['#221540', '#673ab7'],
      indigo: ['#1b2050', '#3f51b5'],
      midnight: ['#10131c', '#2c3e63'],
      steel: ['#1c2a33', '#546e7a'],
      slate: ['#23272b', '#3a4046'],
    };
  }

  _gradient() {
    const g = this._config.gradient;
    if (!g) return null;
    const pair = Array.isArray(g) ? g : AmpMultiroomCard.GRADIENTS[String(g).toLowerCase()];
    if (!pair || pair.length !== 2) return null;
    return `linear-gradient(145deg, ${pair[0]} 0%, ${pair[1]} 130%)`;
  }

  // Apply a named installed theme to this card only (same approach as HA's
  // applyThemesOnElement): set each theme var as a CSS custom property.
  _applyTheme() {
    if (this._appliedThemeVars) {
      for (const p of this._appliedThemeVars) this.style.removeProperty(p);
      this._appliedThemeVars = null;
    }
    const name = this._config.theme;
    if (!name || !this._hass || !this._hass.themes) return;
    const theme = this._hass.themes.themes && this._hass.themes.themes[name];
    if (!theme) return;
    let vars = { ...theme };
    if (vars.modes) {
      const m = this._hass.themes.darkMode ? vars.modes.dark : vars.modes.light;
      delete vars.modes;
      vars = { ...vars, ...(m || {}) };
    }
    this._appliedThemeVars = [];
    for (const [k, v] of Object.entries(vars)) {
      const prop = `--${k}`;
      this.style.setProperty(prop, v);
      this._appliedThemeVars.push(prop);
    }
  }

  // --- one-time DOM ----------------------------------------------------

  _buildDom() {
    const grad = this._gradient();
    const title = this._config.name || 'Multi-room Audio';

    const roomRows = this._rooms
      .map(
        (room, i) => `
        <div class="room-row" data-room="${room}">
          <ha-switch class="room-toggle" data-ref="toggle-${i}"></ha-switch>
          <div class="room-main">
            <div class="room-name" data-ref="name-${i}"></div>
            <div class="vol-row">
              <ha-icon class="vol-ic" icon="mdi:volume-medium"></ha-icon>
              <input type="range" min="0" max="100" step="1" class="vol" data-ref="vol-${i}" data-entity="${room}">
              <span class="vol-pct" data-ref="pct-${i}"></span>
            </div>
          </div>
          <button class="icon-btn room-play" data-ref="play-${i}" title="Play / stop">
            <ha-icon data-ref="playicon-${i}" icon="mdi:play"></ha-icon>
          </button>
        </div>`
      )
      .join('');

    this.innerHTML = `
      <ha-card class="${grad ? 'grad' : ''}" style="${grad ? `background:${grad};border:none;` : ''}">
        <style>
          ha-card.grad .title, ha-card.grad .room-name, ha-card.grad .amp-name { color: #fff; }
          ha-card.grad .sub, ha-card.grad .vol-pct, ha-card.grad .vol-ic, ha-card.grad .hint { color: rgba(255,255,255,0.72); }
          ha-card.grad .src-btn { background: rgba(255,255,255,0.12); color: #fff; }
          ha-card.grad .src-btn:hover { background: rgba(255,255,255,0.2); }
          ha-card.grad .src-btn ha-icon { color: #fff; }
          ha-card.grad .icon-btn { background: rgba(255,255,255,0.12); }
          ha-card.grad .icon-btn:hover { background: rgba(255,255,255,0.2); }
          ha-card.grad .icon-btn ha-icon { color: #fff; }
          ha-card.grad .dropdown-menu { background: #262b30; color: #fff; }
          ha-card.grad .dropdown-item:hover { background: rgba(255,255,255,0.1); }
          ha-card.grad .room-row, ha-card.grad .group-row { border-top-color: rgba(255,255,255,0.14); }
          ha-card.grad input[type=range] { accent-color: #fff; }
        </style>
        <style>
          .acard { padding: 16px; }
          .top-row { display: flex; align-items: center; gap: 10px; position: relative; }
          .title { font-size: 20px; font-weight: 500; color: var(--primary-text-color); flex: 1; min-width: 0; }
          .sub { font-size: 12px; color: var(--secondary-text-color); }
          .src-btn { border: none; border-radius: 12px; background: var(--secondary-background-color, #f2f2f2);
            padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;
            color: var(--primary-text-color); font-family: inherit; max-width: 55%; }
          .src-btn:hover { background: var(--divider-color, #e0e0e0); }
          .src-btn .src-label { display: block; font-size: 11px; color: var(--secondary-text-color); text-align: left; }
          .src-btn .src-sub { display: block; font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .src-btn ha-icon { --mdc-icon-size: 18px; flex: none; }
          .dropdown-menu { position: absolute; top: 44px; right: 0; background: var(--card-background-color, #fff);
            box-shadow: 0 2px 8px rgba(0,0,0,0.25); border-radius: 8px; padding: 4px 0; z-index: 5; min-width: 170px;
            max-height: 260px; overflow: auto; }
          .dropdown-item { padding: 10px 16px; cursor: pointer; font-size: 14px; color: var(--primary-text-color); white-space: nowrap; }
          .dropdown-item:hover { background: var(--secondary-background-color, #f2f2f2); }
          .dropdown-item.selected { color: var(--primary-color); font-weight: 600; }
          .vol-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
          .vol-ic { --mdc-icon-size: 18px; color: var(--secondary-text-color); flex: none; }
          input[type=range].vol { flex: 1; accent-color: var(--primary-color, #03a9f4); height: 22px; margin: 0; min-width: 0; }
          .vol-pct { font-size: 12px; color: var(--secondary-text-color); width: 34px; text-align: right; flex: none; }
          .amp-block { margin-top: 14px; }
          .amp-name { font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
          .group-row { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--divider-color, #e0e0e0); }
          .room-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding-top: 12px;
            border-top: 1px solid var(--divider-color, #e0e0e0); }
          .room-toggle { flex: none; }
          .room-main { flex: 1; min-width: 0; }
          .room-name { font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
          .icon-btn { width: 44px; height: 38px; border-radius: 12px; border: none;
            background: var(--secondary-background-color, #f2f2f2); display: flex; align-items: center;
            justify-content: center; cursor: pointer; flex: none; }
          .icon-btn:hover { background: var(--divider-color, #e0e0e0); }
          .room-row.off .vol-row, .room-row.off .room-play { display: none; }
          .room-row.off .room-name { color: var(--secondary-text-color); font-weight: 400; }
          .hint { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; }
        </style>
        <div class="acard">
          <div class="top-row">
            <div class="title">${title}</div>
            <button class="src-btn" data-ref="src-btn">
              <ha-icon icon="mdi:import"></ha-icon>
              <span style="min-width:0;"><span class="src-label">Source</span><span class="src-sub" data-ref="src-sub">—</span></span>
              <ha-icon icon="mdi:chevron-down"></ha-icon>
            </button>
            <div data-ref="src-menu"></div>
          </div>
          <div class="amp-block">
            <div class="amp-name" data-ref="amp-name"></div>
            <div class="vol-row">
              <ha-icon class="vol-ic" icon="mdi:volume-medium"></ha-icon>
              <input type="range" min="0" max="100" step="1" class="vol" data-ref="amp-vol" data-entity="${this._config.entity}">
              <span class="vol-pct" data-ref="amp-pct"></span>
            </div>
          </div>
          <div class="group-row" data-ref="group-row" style="display:none;">
            <div class="amp-name">All rooms</div>
            <div class="vol-row">
              <ha-icon class="vol-ic" icon="mdi:volume-source"></ha-icon>
              <input type="range" min="0" max="100" step="1" class="vol" data-ref="group-vol" data-entity="__group__">
              <span class="vol-pct" data-ref="group-pct"></span>
            </div>
          </div>
          <div data-ref="rooms">${roomRows}</div>
        </div>
      </ha-card>
    `;

    this._els = {};
    this.querySelectorAll('[data-ref]').forEach((el) => {
      this._els[el.getAttribute('data-ref')] = el;
    });

    // Source dropdown
    this._els['src-btn'].addEventListener('click', (e) => {
      e.stopPropagation();
      this._showSources = !this._showSources;
      this._renderSourceMenu();
    });
    this._outside = (e) => {
      if (this._showSources && !e.composedPath().includes(this)) {
        this._showSources = false;
        this._renderSourceMenu();
      }
    };
    document.addEventListener('click', this._outside, true);

    // Volume sliders (leader, group, rooms) — live label while dragging,
    // service call on release.
    this.querySelectorAll('input[type=range].vol').forEach((slider) => {
      const entity = slider.getAttribute('data-entity');
      slider.addEventListener('input', () => {
        this._dragging[entity] = true;
        this._updateSliderLabel(slider);
      });
      slider.addEventListener('change', () => {
        const pct = parseInt(slider.value, 10);
        delete this._dragging[entity];
        if (entity === '__group__') this._setGroupVolume(pct);
        else this._setVolume(entity, pct);
      });
    });

    // Room toggles and play/stop buttons
    this._rooms.forEach((room, i) => {
      const toggle = this._els[`toggle-${i}`];
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        if (this._isJoined(room)) this._unjoinRoom(room);
        else this._joinRoom(room);
        // optimistic flip; real state confirms via hass updates
        toggle.checked = !this._isJoined(room);
      });
      this._els[`play-${i}`].addEventListener('click', () => {
        const s = this._hass.states[room];
        const playing = s && s.state === 'playing';
        this._callService('media_player', playing ? 'media_stop' : 'media_play', {
          entity_id: room,
        });
      });
    });
  }

  disconnectedCallback() {
    if (this._outside) document.removeEventListener('click', this._outside, true);
  }

  connectedCallback() {
    if (this._built && this._outside) document.addEventListener('click', this._outside, true);
  }

  // --- in-place updates -------------------------------------------------

  _updateDynamic() {
    const leader = this._leader();
    const attrs = leader.attributes || {};

    // Header source
    this._setText(this._els['src-sub'], attrs.source || '—');
    if (this._showSources) this._renderSourceMenu();

    // Leader volume
    const ampName = this._config.amp_name || attrs.friendly_name || this._config.entity;
    this._setText(this._els['amp-name'], ampName);
    this._patchSlider('amp-vol', 'amp-pct', this._config.entity, attrs.volume_level);

    // Group row visible when at least one configured room is joined
    const joinedRooms = this._rooms.filter((r) => this._isJoined(r));
    this._els['group-row'].style.display = joinedRooms.length ? '' : 'none';
    if (joinedRooms.length) {
      const vols = [this._config.entity, ...joinedRooms]
        .map((e) => {
          const s = this._hass.states[e];
          return s && s.attributes ? s.attributes.volume_level : undefined;
        })
        .filter((v) => typeof v === 'number');
      const avg = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
      this._patchSlider('group-vol', 'group-pct', '__group__', avg);
    }

    // Rooms
    this._rooms.forEach((room, i) => {
      const row = this.querySelector(`.room-row[data-room="${CSS.escape(room)}"]`);
      const s = this._hass.states[room];
      const joined = this._isJoined(room);
      this._setText(this._els[`name-${i}`], this._roomName(room));
      if (row) row.classList.toggle('off', !joined);
      const toggle = this._els[`toggle-${i}`];
      // Honour a short optimistic window so the switch doesn't snap back
      // while HEOS forms/dissolves the group.
      const pending = this._pendingJoin[room] && Date.now() - this._pendingJoin[room] < 8000;
      if (!pending && toggle.checked !== joined) toggle.checked = joined;
      if (pending && toggle.checked === joined) delete this._pendingJoin[room];
      if (joined && s) {
        this._patchSlider(`vol-${i}`, `pct-${i}`, room, (s.attributes || {}).volume_level);
        const playing = s.state === 'playing';
        this._setIcon(this._els[`playicon-${i}`], playing ? 'mdi:stop' : 'mdi:play');
      }
    });
  }

  _patchSlider(sliderRef, pctRef, entity, volumeLevel) {
    const slider = this._els[sliderRef];
    if (!slider || this._dragging[entity]) return;
    const pct = typeof volumeLevel === 'number' ? Math.round(volumeLevel * 100) : 0;
    if (parseInt(slider.value, 10) !== pct) slider.value = String(pct);
    this._setText(this._els[pctRef], `${pct}%`);
  }

  _updateSliderLabel(slider) {
    const ref = slider.getAttribute('data-ref');
    const pctRef = ref === 'amp-vol' ? 'amp-pct' : ref === 'group-vol' ? 'group-pct' : ref.replace('vol-', 'pct-');
    this._setText(this._els[pctRef], `${slider.value}%`);
  }

  _renderSourceMenu() {
    const container = this._els['src-menu'];
    if (!this._showSources) {
      if (container.innerHTML !== '') container.innerHTML = '';
      return;
    }
    const current = (this._leader().attributes || {}).source;
    const sources = this._sourceList();
    container.innerHTML = `<div class="dropdown-menu">
      ${sources
        .map(
          (s) =>
            `<div class="dropdown-item ${s === current ? 'selected' : ''}" data-src="${s.replace(/"/g, '&quot;')}">${s}</div>`
        )
        .join('')}
    </div>`;
    container.querySelectorAll('.dropdown-item').forEach((el) => {
      el.addEventListener('click', () => {
        this._callService('media_player', 'select_source', {
          entity_id: this._config.entity,
          source: el.getAttribute('data-src'),
        });
        this._showSources = false;
        this._renderSourceMenu();
      });
    });
  }

  _setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  _setIcon(el, icon) {
    if (el && el.getAttribute('icon') !== icon) el.setAttribute('icon', icon);
  }
}

// ---------------------------------------------------------------------
// Theme picker with gradient swatches (shared pattern with the mycrouch
// card family — shows a sample chip per installed theme).
// ---------------------------------------------------------------------
class AmpThemePicker extends HTMLElement {
  constructor() {
    super();
    this._open = false;
    this._value = '';
    this._hass = null;
    this._themesRef = null;
    this._outside = (e) => {
      if (!e.composedPath().includes(this)) this._toggle(false);
    };
  }

  set hass(h) {
    this._hass = h;
    if (h && h.themes !== this._themesRef) {
      this._themesRef = h.themes;
      this._render();
    }
  }

  set value(v) {
    if ((v || '') === this._value) return;
    this._value = v || '';
    this._render();
  }
  get value() {
    return this._value;
  }

  disconnectedCallback() {
    document.removeEventListener('click', this._outside, true);
  }

  _grad(name) {
    const t =
      this._hass && this._hass.themes && this._hass.themes.themes
        ? this._hass.themes.themes[name]
        : null;
    if (!t) return null;
    const pick = (o) =>
      o && (o['card-gradient'] || o['ha-card-background'] || o['card-background-color']);
    const g = pick(t) || pick(t.modes && t.modes.light) || pick(t.modes && t.modes.dark);
    if (
      typeof g === 'string' &&
      (g.startsWith('linear-gradient') || g.startsWith('#') || g.startsWith('rgb'))
    )
      return g;
    return null;
  }

  _toggle(open) {
    if (open === this._open) return;
    this._open = open;
    if (open) document.addEventListener('click', this._outside, true);
    else document.removeEventListener('click', this._outside, true);
    this._render();
  }

  _render() {
    const names =
      this._hass && this._hass.themes && this._hass.themes.themes
        ? Object.keys(this._hass.themes.themes).sort()
        : [];
    const chip = (g) =>
      `<span class="tp-chip" style="background:${g || 'var(--divider-color,#ccc)'}"></span>`;
    this.innerHTML = `
      <style>
        .tp-wrap { position: relative; display: block; margin-top: 12px; }
        .tp-field { display: flex; align-items: center; gap: 10px;
          border: 1px solid var(--divider-color, #ccc); border-radius: 8px;
          padding: 12px; cursor: pointer;
          background: var(--mdc-text-field-fill-color, var(--secondary-background-color, #f5f5f5)); }
        .tp-lbl { font-size: .75em; color: var(--secondary-text-color); }
        .tp-chip { width: 30px; height: 18px; border-radius: 4px; flex: none;
          border: 1px solid rgba(127,127,127,.35); }
        .tp-name { flex: 1; color: var(--primary-text-color); }
        .tp-caret { opacity: .6; }
        .tp-list { position: absolute; z-index: 12; left: 0; right: 0; top: calc(100% + 2px);
          max-height: 280px; overflow: auto;
          background: var(--card-background-color, #fff);
          border: 1px solid var(--divider-color, #ccc); border-radius: 8px;
          box-shadow: 0 4px 16px rgba(0,0,0,.25); }
        .tp-opt { display: flex; align-items: center; gap: 10px; padding: 9px 12px;
          cursor: pointer; color: var(--primary-text-color); }
        .tp-opt:hover { background: rgba(127,127,127,.12); }
        .tp-opt.sel { background: rgba(127,127,127,.2); }
      </style>
      <div class="tp-wrap">
        <div class="tp-field" role="button" aria-haspopup="listbox">
          ${chip(this._grad(this._value))}
          <span class="tp-name">${this._value || 'Select a theme'}<br><span class="tp-lbl">Theme</span></span>
          <span class="tp-caret">&#9662;</span>
        </div>
        ${
          this._open
            ? `<div class="tp-list" role="listbox">${names
                .map(
                  (n) =>
                    `<div class="tp-opt ${n === this._value ? 'sel' : ''}" data-n="${n}">${chip(this._grad(n))}<span>${n}</span></div>`
                )
                .join('')}</div>`
            : ''
        }
      </div>`;
    this.querySelector('.tp-field').addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggle(!this._open);
    });
    this.querySelectorAll('.tp-opt').forEach((o) =>
      o.addEventListener('click', (e) => {
        e.stopPropagation();
        this._value = o.dataset.n;
        this._toggle(false);
        this._render();
        this.dispatchEvent(
          new CustomEvent('value-changed', {
            detail: { value: this._value },
            bubbles: true,
            composed: true,
          })
        );
      })
    );
  }
}

// ---------------------------------------------------------------------
// GUI editor
// ---------------------------------------------------------------------
class AmpMultiroomCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._form = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    if (this._picker) this._picker.hass = hass;
  }

  setConfig(config) {
    // Echo guard: HA re-feeds emitted config into setConfig; skip identical
    // configs so typing in text fields doesn't lose focus.
    const normalized = JSON.stringify({ ...config, type: undefined });
    if (this._normalized === normalized) return;
    this._normalized = normalized;
    this._config = { ...config };
    if (config.theme) this._mode = 'theme';
    else if (config.gradient) this._mode = 'manual';
    else this._mode = 'default';
    this._render();
  }

  _emit(config) {
    this._normalized = JSON.stringify({ ...config, type: undefined });
    this.dispatchEvent(
      new CustomEvent('config-changed', {
        detail: { config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _buildConfig(v) {
    const config = {
      type: (this._config && this._config.type) || 'custom:amp-multiroom-card',
      entity: v.entity,
    };
    if (v.name) config.name = v.name;
    if (v.amp_name) config.amp_name = v.amp_name;
    if (Array.isArray(v.rooms) && v.rooms.length) config.rooms = v.rooms;
    if (v.join_script) config.join_script = v.join_script;
    if (Array.isArray(v.sources) && v.sources.length) config.sources = v.sources;
    if (this._config && this._config.room_names) config.room_names = this._config.room_names;
    if (v.mode === 'theme') {
      const th = v.theme || (this._config && this._config.theme);
      if (th) config.theme = th;
    } else if (v.mode === 'manual' && v.gradient_from && v.gradient_to) {
      config.gradient = [v.gradient_from, v.gradient_to];
    }
    return config;
  }

  _render() {
    if (!this._config) return;
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.computeLabel = (s) => s.label || s.name;
      this._form.addEventListener('value-changed', (ev) => {
        ev.stopPropagation();
        const v = ev.detail.value;
        const modeChanged = v.mode !== this._mode;
        this._mode = v.mode;
        const config = this._buildConfig(v);
        this._config = config;
        this._emit(config);
        if (modeChanged) {
          this._updateSchema(v);
          this._syncPicker();
        }
      });
      this.appendChild(this._form);
    }
    this._updateSchema();
    if (this._hass) this._form.hass = this._hass;
    this._syncPicker();
  }

  _syncPicker() {
    if (this._mode === 'theme') {
      if (!this._picker) {
        this._picker = document.createElement('amp-theme-picker');
        this._picker.addEventListener('value-changed', (ev) => {
          ev.stopPropagation();
          const config = { ...this._config, theme: ev.detail.value };
          delete config.gradient;
          this._config = config;
          this._emit(config);
        });
        this.appendChild(this._picker);
      }
      if (this._hass) this._picker.hass = this._hass;
      this._picker.value = this._config.theme || '';
    } else if (this._picker) {
      this._picker.remove();
      this._picker = null;
    }
  }

  _updateSchema(current) {
    const g = this._config.gradient;
    // Source options come live from the selected leader's source_list.
    const leader =
      this._hass && this._config.entity ? this._hass.states[this._config.entity] : null;
    const sourceOptions =
      (leader && leader.attributes && leader.attributes.source_list) || [];
    const schema = [
      {
        name: 'entity',
        label: 'Leader (AMP) media player',
        required: true,
        selector: { entity: { domain: 'media_player' } },
      },
      {
        name: 'rooms',
        label: 'Room speakers',
        selector: { entity: { domain: 'media_player', multiple: true } },
      },
      { name: 'name', label: 'Card title (optional)', selector: { text: {} } },
      { name: 'amp_name', label: 'Leader display name (optional)', selector: { text: {} } },
      {
        name: 'join_script',
        label: 'Join script (optional — reliable analogue streaming)',
        selector: { entity: { domain: 'script' } },
      },
    ];
    if (sourceOptions.length) {
      schema.push({
        name: 'sources',
        label: 'Sources to show (optional filter)',
        selector: {
          select: { multiple: true, mode: 'dropdown', options: sourceOptions },
        },
      });
    }
    schema.push({
      name: 'mode',
      label: 'Style',
      selector: {
        select: {
          mode: 'dropdown',
          options: [
            { value: 'default', label: 'Default (basic card)' },
            { value: 'theme', label: 'Theme (apply an installed theme)' },
            { value: 'manual', label: 'Manual gradient colours' },
          ],
        },
      },
    });
    if (this._mode === 'manual') {
      schema.push(
        { name: 'gradient_from', label: 'From colour (e.g. #0d2b45)', selector: { text: {} } },
        { name: 'gradient_to', label: 'To colour (e.g. #1565c0)', selector: { text: {} } }
      );
    }
    this._form.schema = schema;
    this._form.data = {
      entity: (current && current.entity) || this._config.entity || '',
      rooms: (current && current.rooms) || this._config.rooms || [],
      name: (current && current.name) || this._config.name || '',
      amp_name: (current && current.amp_name) || this._config.amp_name || '',
      join_script: (current && current.join_script) || this._config.join_script || '',
      sources: (current && current.sources) || this._config.sources || [],
      mode: this._mode,
      theme: (current && current.theme) || this._config.theme || '',
      gradient_from: (current && current.gradient_from) || (Array.isArray(g) ? g[0] : ''),
      gradient_to: (current && current.gradient_to) || (Array.isArray(g) ? g[1] : ''),
    };
  }
}

customElements.define('amp-multiroom-card', AmpMultiroomCard);
customElements.define('amp-multiroom-card-editor', AmpMultiroomCardEditor);
customElements.define('amp-theme-picker', AmpThemePicker);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'amp-multiroom-card',
  name: 'AMP Multi-room Card',
  preview: true,
  documentationURL: 'https://github.com/mycrouch/amp-multiroom-card',
  description:
    'One-card multi-room audio for a HEOS group leader: source picker, leader and all-rooms volume, and per-room join/volume/play-stop rows, with reliable analogue-source streaming via an optional join script.',
});

console.info(
  `%c AMP-MULTIROOM-CARD %c v${AMP_CARD_VERSION} `,
  'color: white; background: #03a9f4; font-weight: 700;',
  'color: #03a9f4; background: white; font-weight: 700;'
);
