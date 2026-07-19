/*
 * HEOS Multiroom Card v1.5.1
 * https://github.com/mycrouch/heos-multiroom-card
 *
 * One-card multi-room audio for HEOS: pick a group leader from your pool of
 * players (any HEOS unit with a physical input can lead — AVR turntable,
 * a speaker's AUX/USB), toggle rooms in and out of the group, and control
 * every device's volume and mute individually — including muting the leader
 * locally while its source keeps streaming to the rooms. Pairs with a small
 * server-side join script (one-click creation from the card editor) that
 * works around HEOS's silent-follower bug on analogue sources.
 *
 * MIT License — Jason Crouch. Icons: Material Design Icons via ha-icon.
 */

const HEOS_CARD_VERSION = '1.5.1';
const HEOS_JOIN_SCRIPT_ID = 'heos_join_room';

// Server-side companion script created by the editor's one-click setup.
// Generic: takes leader + room, so one script serves every card instance.
const HEOS_JOIN_SCRIPT_CONFIG = {
  alias: 'HEOS - Join Room to Leader',
  description:
    'Created by HEOS Multiroom Card. Joins a HEOS room speaker to a group ' +
    "leader and makes sure it actually starts playing (works around HEOS's " +
    'silent-follower bug on analogue sources): join, verify, press play, ' +
    'and if still silent unjoin/rejoin and play again.',
  fields: {
    leader: {
      name: 'Group leader',
      required: true,
      selector: { entity: { domain: 'media_player' } },
    },
    room: {
      name: 'Room speaker',
      required: true,
      selector: { entity: { domain: 'media_player' } },
    },
  },
  sequence: [
    {
      action: 'media_player.join',
      target: { entity_id: '{{ leader }}' },
      data: { group_members: ['{{ room }}'] },
    },
    {
      wait_template: "{{ is_state(room, 'playing') }}",
      timeout: { seconds: 6 },
      continue_on_timeout: true,
    },
    {
      if: [
        {
          condition: 'template',
          value_template: "{{ not is_state(room, 'playing') }}",
        },
      ],
      then: [
        { action: 'media_player.media_play', target: { entity_id: '{{ room }}' } },
        {
          wait_template: "{{ is_state(room, 'playing') }}",
          timeout: { seconds: 6 },
          continue_on_timeout: true,
        },
      ],
    },
    {
      if: [
        {
          condition: 'template',
          value_template: "{{ not is_state(room, 'playing') }}",
        },
      ],
      then: [
        { action: 'media_player.unjoin', target: { entity_id: '{{ room }}' } },
        { delay: { seconds: 2 } },
        {
          action: 'media_player.join',
          target: { entity_id: '{{ leader }}' },
          data: { group_members: ['{{ room }}'] },
        },
        { delay: { seconds: 2 } },
        { action: 'media_player.media_play', target: { entity_id: '{{ room }}' } },
      ],
    },
  ],
  mode: 'parallel',
  max: 10,
};

class HeosMultiroomCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement('heos-multiroom-card-editor');
  }

  static getStubConfig(hass) {
    // Grouping-capable media players (GROUPING feature bit 524288). Default
    // leader = the unit with the most sources (an AVR beats a speaker).
    const players = Object.keys(hass.states)
      .filter((e) => e.startsWith('media_player.'))
      .filter((e) => ((hass.states[e].attributes.supported_features || 0) & 524288) !== 0)
      .slice(0, 5);
    let leader = players[0] || '';
    let best = -1;
    players.forEach((e) => {
      const n = ((hass.states[e].attributes || {}).source_list || []).length;
      if (n > best) {
        best = n;
        leader = e;
      }
    });
    return { players, default_leader: leader };
  }

  setConfig(config) {
    // v1.2+ config: players + default_leader. Back-compat with v1.0/1.1
    // entity + rooms (absent new option = previous behaviour).
    let players = Array.isArray(config.players) ? [...config.players] : null;
    let defaultLeader = config.default_leader || null;
    if (!players) {
      const rooms = Array.isArray(config.rooms) ? config.rooms : [];
      if (!config.entity) {
        throw new Error('Define players (list of media_players) or a legacy entity');
      }
      players = [config.entity, ...rooms];
      defaultLeader = defaultLeader || config.entity;
    }
    if (!players.length) throw new Error('players must contain at least one media_player');
    if (!defaultLeader || !players.includes(defaultLeader)) defaultLeader = players[0];
    this._config = config;
    this._players = players;
    this._defaultLeader = defaultLeader;
    this._names = config.names || config.room_names || {};
    // Optional map: HEOS player -> its receiver entity (e.g. from the
    // denonavr integration). Adds power + sound-mode controls when that
    // player is the leader.
    this._avrMap = config.avr_entities || {};
    // Optional per-player sound-mode filter (integrations offer generic
    // model lists; hide the modes this receiver ignores).
    this._modeFilter = config.sound_modes || {};
    this._userLeader = null; // manual pick on the card, session-scoped
    this._builtLeader = null;
    this._built = false;
    this._errorShown = false;
    this._showSources = false;
    this._showLeaders = false;
    this._showModes = false;
    this._dragging = {};
    this._pendingJoin = {};
    this._renderKey = '';
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const missing = this._players.filter((p) => !hass.states[p]);
    if (missing.length === this._players.length) {
      if (!this._errorShown) {
        this.innerHTML = `<ha-card><div style="padding:16px;">Entities not found: ${missing.join(', ')}</div></ha-card>`;
        this._errorShown = true;
        this._built = false;
      }
      return;
    }
    this._errorShown = false;
    const leader = this._currentLeader();
    if (!this._built || this._builtLeader !== leader) {
      this._buildDom(leader);
      this._built = true;
      this._builtLeader = leader;
      this._appliedThemeName = undefined;
      this._renderKey = '';
    }
    const wantTheme = this._config.theme || null;
    const dark = hass.themes && hass.themes.darkMode;
    if (this._appliedThemeName !== wantTheme || this._appliedThemeDark !== dark) {
      this._applyTheme();
      this._appliedThemeName = wantTheme;
      this._appliedThemeDark = dark;
    }
    const key = this._buildRenderKey(leader);
    if (key !== this._renderKey) {
      this._renderKey = key;
      this._updateDynamic(leader);
    }
  }

  _buildRenderKey(leader) {
    const parts = [leader];
    this._players.forEach((id) => {
      const s = this._hass.states[id];
      if (!s) {
        parts.push(`${id}:missing`);
        return;
      }
      const a = s.attributes || {};
      parts.push(
        `${id}:${s.state}:${a.source || ''}:${a.volume_level ?? ''}:${a.is_volume_muted ? 'm' : ''}:${(a.group_members || []).join(',')}`
      );
    });
    Object.values(this._avrMap).forEach((avr) => {
      const s = this._hass.states[avr];
      const a = (s && s.attributes) || {};
      parts.push(`${avr}:${s ? s.state : 'missing'}:${a.sound_mode || ''}`);
    });
    return parts.join('|');
  }

  getCardSize() {
    return 2 + this._players.length;
  }

  // --- leader / group helpers ------------------------------------------

  // Live leader detection: HA's group_members convention puts the leader
  // first. A configured player actively leading a multi-member group wins;
  // otherwise the user's session pick; otherwise the configured default.
  _currentLeader() {
    for (const p of this._players) {
      const s = this._hass.states[p];
      const gm = (s && s.attributes && s.attributes.group_members) || [];
      if (gm.length > 1 && gm[0] === p) return p;
    }
    if (this._userLeader && this._players.includes(this._userLeader)) return this._userLeader;
    return this._defaultLeader;
  }

  _rooms(leader) {
    return this._players.filter((p) => p !== leader);
  }

  _groupMembers(leader) {
    const l = this._hass.states[leader];
    return (l && l.attributes && l.attributes.group_members) || [];
  }

  _isJoined(leader, room) {
    return this._groupMembers(leader).includes(room);
  }

  _displayName(id) {
    if (this._names[id]) return this._names[id];
    if (id === this._builtLeader && this._config.amp_name) return this._config.amp_name;
    const s = this._hass.states[id];
    return (s && s.attributes && s.attributes.friendly_name) || id;
  }

  _sourceList(leader) {
    const l = this._hass.states[leader];
    const all = (l && l.attributes && l.attributes.source_list) || [];
    // sources: per-leader map {entity: [..]} (v1.4+), or legacy flat array
    // applied to every leader. HEOS shares all inputs system-wide, so this
    // is a per-leader presentation filter, not a capability limit.
    const cfg = this._config.sources;
    let filter = null;
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) filter = cfg[leader];
    else if (Array.isArray(cfg)) filter = cfg;
    if (Array.isArray(filter) && filter.length) {
      const filtered = filter.filter((s) => all.includes(s));
      if (filtered.length) return filtered;
    }
    return all;
  }

  _callService(domain, service, data) {
    this._hass.callService(domain, service, data);
  }

  _joinRoom(leader, room) {
    this._pendingJoin[room] = Date.now();
    const script = this._config.join_script;
    if (script) {
      const name = script.replace(/^script\./, '');
      this._callService('script', name, { leader, room });
    } else {
      this._callService('media_player', 'join', {
        entity_id: leader,
        group_members: [room],
      });
    }
  }

  _unjoinRoom(room) {
    this._pendingJoin[room] = Date.now();
    this._callService('media_player', 'unjoin', { entity_id: room });
  }

  _toggleMute(entityId) {
    const s = this._hass.states[entityId];
    const muted = !!(s && s.attributes && s.attributes.is_volume_muted);
    this._callService('media_player', 'volume_mute', {
      entity_id: entityId,
      is_volume_muted: !muted,
    });
  }

  _switchLeader(newLeader) {
    const oldLeader = this._currentLeader();
    if (newLeader === oldLeader) return;
    // Dissolve any active group led by the old leader before switching —
    // predictable, documented behaviour.
    const gm = this._groupMembers(oldLeader);
    if (gm.length > 1) {
      gm.filter((e) => e !== oldLeader).forEach((e) =>
        this._callService('media_player', 'unjoin', { entity_id: e })
      );
    }
    this._userLeader = newLeader;
    this._showLeaders = false;
    this._built = false; // rebuild around the new leader
    this._renderKey = '';
    if (this._hass) this.hass = this._hass;
  }

  _setVolume(entityId, pct) {
    this._callService('media_player', 'volume_set', {
      entity_id: entityId,
      volume_level: Math.min(1, Math.max(0, pct / 100)),
    });
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
    const pair = Array.isArray(g) ? g : HeosMultiroomCard.GRADIENTS[String(g).toLowerCase()];
    if (!pair || pair.length !== 2) return null;
    return `linear-gradient(145deg, ${pair[0]} 0%, ${pair[1]} 130%)`;
  }

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

  // --- DOM (rebuilt when the leader changes) ---------------------------

  _buildDom(leader) {
    const grad = this._gradient();
    const title = this._config.name || 'Multi-room Audio';
    const rooms = this._rooms(leader);
    const multiLeader = this._players.length > 1;
    const avr = this._avrMap[leader];

    const roomRows = rooms
      .map(
        (room, i) => `
        <div class="room-row" data-room="${room}">
          <ha-switch class="room-toggle" data-ref="toggle-${i}"></ha-switch>
          <div class="room-main">
            <div class="room-name"><span data-ref="name-${i}"></span><span class="state-tag" data-ref="state-${i}"></span></div>
            <div class="vol-row">
              <ha-icon class="vol-ic" icon="mdi:volume-medium"></ha-icon>
              <input type="range" min="0" max="100" step="1" class="vol" data-ref="vol-${i}" data-entity="${room}">
              <span class="vol-pct" data-ref="pct-${i}"></span>
            </div>
          </div>
          <button class="icon-btn" data-ref="mute-${i}" title="Mute / unmute">
            <ha-icon data-ref="muteicon-${i}" icon="mdi:volume-high"></ha-icon>
          </button>
          <button class="icon-btn room-play" data-ref="play-${i}" title="Play / stop">
            <ha-icon data-ref="playicon-${i}" icon="mdi:play"></ha-icon>
          </button>
        </div>`
      )
      .join('');

    this.innerHTML = `
      <ha-card class="${grad ? 'grad' : ''}" style="${grad ? `background:${grad};border:none;` : ''}">
        <style>
          ha-card.grad .title, ha-card.grad .room-name { color: #fff; }
          ha-card.grad .sub, ha-card.grad .vol-pct, ha-card.grad .vol-ic, ha-card.grad .leader-tag { color: rgba(255,255,255,0.72); }
          ha-card.grad .src-btn { background: rgba(255,255,255,0.12); color: #fff; }
          ha-card.grad .src-btn:hover { background: rgba(255,255,255,0.2); }
          ha-card.grad .src-btn ha-icon { color: #fff; }
          ha-card.grad .icon-btn { background: rgba(255,255,255,0.12); }
          ha-card.grad .icon-btn:hover { background: rgba(255,255,255,0.2); }
          ha-card.grad .icon-btn ha-icon { color: #fff; }
          ha-card.grad .icon-btn.active { background: rgba(255,255,255,0.85); }
          ha-card.grad .icon-btn.active ha-icon { color: #1565c0; }
          ha-card.grad .state-tag { color: rgba(255,255,255,0.72); }
          ha-card.grad .dropdown-menu { background: #262b30; color: #fff; }
          ha-card.grad .dropdown-item:hover { background: rgba(255,255,255,0.1); }
          ha-card.grad .room-row { border-top-color: rgba(255,255,255,0.14); }
          ha-card.grad input[type=range] { accent-color: #fff; }
        </style>
        <style>
          .acard { padding: 16px; }
          .title { font-size: 20px; font-weight: 500; color: var(--primary-text-color); }
          .ctrl-row { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
          .ctrl-wrap { position: relative; flex: 1 1 44%; min-width: 0; }
          .src-btn { width: 100%; border: none; border-radius: 12px; background: var(--secondary-background-color, #f2f2f2);
            padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;
            color: var(--primary-text-color); font-family: inherit; }
          .src-btn:hover { background: var(--divider-color, #e0e0e0); }
          .src-btn[disabled] { cursor: default; }
          .src-btn .src-label { display: block; font-size: 11px; color: var(--secondary-text-color); text-align: left; }
          .src-btn .src-sub { display: block; font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; }
          .src-btn > span { min-width: 0; flex: 1; }
          .src-btn ha-icon { --mdc-icon-size: 18px; flex: none; }
          .dropdown-menu { position: absolute; top: calc(100% + 4px); left: 0; min-width: 100%;
            background: var(--card-background-color, #fff);
            box-shadow: 0 2px 8px rgba(0,0,0,0.25); border-radius: 8px; padding: 4px 0; z-index: 5;
            max-height: min(65vh, 440px); overflow: auto; overscroll-behavior: contain; }
          .dropdown-item { padding: 10px 16px; cursor: pointer; font-size: 14px; color: var(--primary-text-color); white-space: nowrap; }
          .dropdown-item:hover { background: var(--secondary-background-color, #f2f2f2); }
          .dropdown-item.selected { color: var(--primary-color); font-weight: 600; }
          .vol-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
          .vol-ic { --mdc-icon-size: 18px; color: var(--secondary-text-color); flex: none; }
          input[type=range].vol { flex: 1; accent-color: var(--primary-color, #03a9f4); height: 22px; margin: 0; min-width: 0; }
          .vol-pct { font-size: 12px; color: var(--secondary-text-color); width: 34px; text-align: right; flex: none; }
          .leader-tag { font-size: 11px; color: var(--secondary-text-color); margin-left: 6px; font-weight: 400; }
          .room-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding-top: 12px;
            border-top: 1px solid var(--divider-color, #e0e0e0); }
          .room-row.leader-row { border-top: none; padding-top: 0; margin-top: 14px; }
          .room-toggle { flex: none; }
          .room-main { flex: 1; min-width: 0; }
          .room-name { font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
          .icon-btn { width: 44px; height: 38px; border-radius: 12px; border: none;
            background: var(--secondary-background-color, #f2f2f2); display: flex; align-items: center;
            justify-content: center; cursor: pointer; flex: none; }
          .icon-btn:hover { background: var(--divider-color, #e0e0e0); }
          .icon-btn.muted ha-icon { color: var(--error-color, #db4437); }
          .icon-btn.active { background: var(--primary-color, #03a9f4); }
          .icon-btn.active ha-icon { color: #fff; }
          .state-tag { font-size: 11px; color: var(--primary-color, #03a9f4); margin-left: 6px; font-weight: 500; }
          .room-row.off .vol-row, .room-row.off .room-play, .room-row.off [data-ref^="mute-"] { display: none; }
          .room-row.off .room-name { color: var(--secondary-text-color); font-weight: 400; }
        </style>
        <div class="acard">
          <div class="title">${title}</div>
          <div class="ctrl-row">
            <div class="ctrl-wrap">
              <button class="src-btn" data-ref="src-btn">
                <ha-icon icon="mdi:import"></ha-icon>
                <span><span class="src-label">Source</span><span class="src-sub" data-ref="src-sub">—</span></span>
                <ha-icon icon="mdi:chevron-down"></ha-icon>
              </button>
              <div data-ref="src-menu"></div>
            </div>
            <div class="ctrl-wrap">
              <button class="src-btn" data-ref="leader-btn" ${multiLeader ? '' : 'disabled'}>
                <ha-icon icon="mdi:account-music"></ha-icon>
                <span><span class="src-label">Leader</span><span class="src-sub" data-ref="leader-sub">—</span></span>
                <ha-icon icon="mdi:chevron-down" style="${multiLeader ? '' : 'visibility:hidden;'}"></ha-icon>
              </button>
              <div data-ref="leader-menu"></div>
            </div>
            ${avr ? `
            <div class="ctrl-wrap">
              <button class="src-btn" data-ref="sm-btn">
                <ha-icon icon="mdi:surround-sound"></ha-icon>
                <span><span class="src-label">Sound mode</span><span class="src-sub" data-ref="sm-sub">—</span></span>
                <ha-icon icon="mdi:chevron-down"></ha-icon>
              </button>
              <div data-ref="sm-menu"></div>
            </div>` : ''}
          </div>
          <div class="room-row leader-row">
            <div class="room-main">
              <div class="room-name"><span data-ref="leader-name"></span><span class="leader-tag">leader</span></div>
              <div class="vol-row">
                <ha-icon class="vol-ic" icon="mdi:volume-medium"></ha-icon>
                <input type="range" min="0" max="100" step="1" class="vol" data-ref="leader-vol" data-entity="${leader}">
                <span class="vol-pct" data-ref="leader-pct"></span>
              </div>
            </div>
            ${avr ? `
            <button class="icon-btn" data-ref="power-btn" title="Receiver power">
              <ha-icon icon="mdi:power"></ha-icon>
            </button>` : ''}
            <button class="icon-btn" data-ref="mute-leader" title="Mute / unmute (stream to rooms keeps playing)">
              <ha-icon data-ref="muteicon-leader" icon="mdi:volume-high"></ha-icon>
            </button>
          </div>
          <div data-ref="rooms">${roomRows}</div>
        </div>
      </ha-card>
    `;

    this._els = {};
    this.querySelectorAll('[data-ref]').forEach((el) => {
      this._els[el.getAttribute('data-ref')] = el;
    });

    const closeAllMenus = () => {
      this._showSources = false;
      this._showLeaders = false;
      this._showModes = false;
    };
    const renderAllMenus = () => {
      this._renderSourceMenu(leader);
      this._renderLeaderMenu(leader);
      this._renderModeMenu(leader);
    };

    // Source dropdown
    this._els['src-btn'].addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !this._showSources;
      closeAllMenus();
      this._showSources = open;
      renderAllMenus();
    });

    // Leader dropdown
    if (multiLeader) {
      this._els['leader-btn'].addEventListener('click', (e) => {
        e.stopPropagation();
        const open = !this._showLeaders;
        closeAllMenus();
        this._showLeaders = open;
        renderAllMenus();
      });
    }

    // Sound-mode dropdown + receiver power (only when a receiver entity
    // is linked to the current leader via avr_entities)
    if (avr) {
      this._els['sm-btn'].addEventListener('click', (e) => {
        e.stopPropagation();
        const open = !this._showModes;
        closeAllMenus();
        this._showModes = open;
        renderAllMenus();
      });
      this._els['power-btn'].addEventListener('click', () => {
        const s = this._hass.states[avr];
        const off = !s || s.state === 'off';
        this._callService('media_player', off ? 'turn_on' : 'turn_off', { entity_id: avr });
      });
    }

    if (this._outside) document.removeEventListener('click', this._outside, true);
    this._outside = (e) => {
      if (
        (this._showSources || this._showLeaders || this._showModes) &&
        !e.composedPath().includes(this)
      ) {
        closeAllMenus();
        renderAllMenus();
      }
    };
    document.addEventListener('click', this._outside, true);

    // Volume sliders — live label while dragging, service call on release.
    this.querySelectorAll('input[type=range].vol').forEach((slider) => {
      const entity = slider.getAttribute('data-entity');
      slider.addEventListener('input', () => {
        this._dragging[entity] = true;
        this._updateSliderLabel(slider);
      });
      slider.addEventListener('change', () => {
        const pct = parseInt(slider.value, 10);
        delete this._dragging[entity];
        this._setVolume(entity, pct);
      });
    });

    // Leader mute
    this._els['mute-leader'].addEventListener('click', () => this._toggleMute(leader));

    // Room toggles, mute, play/stop
    rooms.forEach((room, i) => {
      const toggle = this._els[`toggle-${i}`];
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        if (this._isJoined(leader, room)) this._unjoinRoom(room);
        else this._joinRoom(leader, room);
        toggle.checked = !this._isJoined(leader, room);
      });
      this._els[`mute-${i}`].addEventListener('click', () => this._toggleMute(room));
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

  _updateDynamic(leader) {
    const l = this._hass.states[leader];
    const attrs = (l && l.attributes) || {};
    const rooms = this._rooms(leader);

    this._setText(this._els['src-sub'], attrs.source || '—');
    this._setText(this._els['leader-sub'], this._displayName(leader));
    if (this._showSources) this._renderSourceMenu(leader);

    this._setText(this._els['leader-name'], this._displayName(leader));
    this._patchSlider('leader-vol', 'leader-pct', leader, attrs.volume_level);
    this._patchMute('mute-leader', 'muteicon-leader', attrs.is_volume_muted);

    // Receiver companion (power + sound mode)
    const avr = this._avrMap[leader];
    if (avr) {
      const as = this._hass.states[avr];
      const aa = (as && as.attributes) || {};
      const isOn = as && as.state !== 'off' && as.state !== 'unavailable';
      this._setText(this._els['sm-sub'], isOn ? aa.sound_mode || '—' : 'Off');
      const pbtn = this._els['power-btn'];
      if (pbtn) pbtn.classList.toggle('active', !!isOn);
      const smBtn = this._els['sm-btn'];
      if (smBtn) smBtn.disabled = !isOn;
      if (this._showModes) this._renderModeMenu(leader);
    }

    rooms.forEach((room, i) => {
      const row = this.querySelector(`.room-row[data-room="${CSS.escape(room)}"]`);
      const s = this._hass.states[room];
      const a = (s && s.attributes) || {};
      const joined = this._isJoined(leader, room);
      this._setText(this._els[`name-${i}`], this._displayName(room));
      if (row) row.classList.toggle('off', !joined);
      const toggle = this._els[`toggle-${i}`];
      const pending = this._pendingJoin[room] && Date.now() - this._pendingJoin[room] < 8000;
      if (!pending && toggle.checked !== joined) toggle.checked = joined;
      if (pending && toggle.checked === joined) delete this._pendingJoin[room];
      if (joined && s) {
        this._patchSlider(`vol-${i}`, `pct-${i}`, room, a.volume_level);
        this._patchMute(`mute-${i}`, `muteicon-${i}`, a.is_volume_muted);
        const playing = s.state === 'playing';
        this._setIcon(this._els[`playicon-${i}`], playing ? 'mdi:stop' : 'mdi:play');
        this._els[`play-${i}`].classList.toggle('active', playing);
        this._setText(this._els[`state-${i}`], playing ? 'playing' : '');
      } else {
        this._setText(this._els[`state-${i}`], '');
      }
    });
  }

  _patchMute(btnRef, iconRef, muted) {
    const btn = this._els[btnRef];
    if (btn) btn.classList.toggle('muted', !!muted);
    this._setIcon(this._els[iconRef], muted ? 'mdi:volume-off' : 'mdi:volume-high');
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
    const pctRef = ref === 'leader-vol' ? 'leader-pct' : ref.replace('vol-', 'pct-');
    this._setText(this._els[pctRef], `${slider.value}%`);
  }

  _renderSourceMenu(leader) {
    const container = this._els['src-menu'];
    if (!container) return;
    if (!this._showSources) {
      if (container.innerHTML !== '') container.innerHTML = '';
      return;
    }
    const current = ((this._hass.states[leader] || {}).attributes || {}).source;
    const sources = this._sourceList(leader);
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
          entity_id: leader,
          source: el.getAttribute('data-src'),
        });
        this._showSources = false;
        this._renderSourceMenu(leader);
      });
    });
  }

  _renderModeMenu(leader) {
    const container = this._els['sm-menu'];
    if (!container) return;
    if (!this._showModes) {
      if (container.innerHTML !== '') container.innerHTML = '';
      return;
    }
    const avr = this._avrMap[leader];
    const as = this._hass.states[avr];
    const aa = (as && as.attributes) || {};
    const current = aa.sound_mode;
    let modes = aa.sound_mode_list || [];
    const mf = this._modeFilter[leader];
    if (Array.isArray(mf) && mf.length) {
      const filtered = modes.filter((m) => mf.includes(m));
      if (filtered.length) modes = filtered;
    }
    container.innerHTML = `<div class="dropdown-menu">
      ${modes
        .map(
          (m) =>
            `<div class="dropdown-item ${m === current ? 'selected' : ''}" data-m="${m.replace(/"/g, '&quot;')}">${m}</div>`
        )
        .join('')}
    </div>`;
    container.querySelectorAll('.dropdown-item').forEach((el) => {
      el.addEventListener('click', () => {
        this._callService('media_player', 'select_sound_mode', {
          entity_id: avr,
          sound_mode: el.getAttribute('data-m'),
        });
        this._showModes = false;
        this._renderModeMenu(leader);
      });
    });
  }

  _renderLeaderMenu(leader) {
    const container = this._els['leader-menu'];
    if (!container) return;
    if (!this._showLeaders) {
      if (container.innerHTML !== '') container.innerHTML = '';
      return;
    }
    container.innerHTML = `<div class="dropdown-menu">
      ${this._players
        .map(
          (p) =>
            `<div class="dropdown-item ${p === leader ? 'selected' : ''}" data-p="${p}">${this._displayName(p)}</div>`
        )
        .join('')}
    </div>`;
    container.querySelectorAll('.dropdown-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this._switchLeader(el.getAttribute('data-p'));
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
// card family).
// ---------------------------------------------------------------------
class HeosThemePicker extends HTMLElement {
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
// GUI editor — with one-click server-side join-script setup.
// ---------------------------------------------------------------------
class HeosMultiroomCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._form = null;
    this._setupStatus = '';
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    if (this._picker) this._picker.hass = hass;
    this._syncSetupRow();
  }

  setConfig(config) {
    const normalized = JSON.stringify({ ...config, type: undefined });
    if (this._normalized === normalized) return;
    this._normalized = normalized;
    this._config = { ...config };
    if (config.theme) this._mode = 'theme';
    else if (config.gradient) this._mode = 'manual';
    else this._mode = 'default';
    this._render();
  }

  _players() {
    if (Array.isArray(this._config.players)) return this._config.players;
    if (this._config.entity)
      return [this._config.entity, ...(this._config.rooms || [])];
    return [];
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
      type: (this._config && this._config.type) || 'custom:heos-multiroom-card',
    };
    if (Array.isArray(v.players) && v.players.length) config.players = v.players;
    if (v.default_leader && (config.players || []).includes(v.default_leader))
      config.default_leader = v.default_leader;
    if (v.name) config.name = v.name;
    if (v.join_script) config.join_script = v.join_script;
    const srcMap = {};
    const avrMap = {};
    const smfMap = {};
    (config.players || []).forEach((p, i) => {
      const list = v[`src_${i}`];
      if (Array.isArray(list) && list.length) srcMap[p] = list;
      const a = v[`avr_${i}`];
      if (a) avrMap[p] = a;
      const sm = v[`smf_${i}`];
      if (Array.isArray(sm) && sm.length) smfMap[p] = sm;
    });
    if (Object.keys(srcMap).length) config.sources = srcMap;
    if (Object.keys(avrMap).length) config.avr_entities = avrMap;
    if (Object.keys(smfMap).length) config.sound_modes = smfMap;
    if (this._config && (this._config.names || this._config.room_names))
      config.names = this._config.names || this._config.room_names;
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
        this._updateSchema(v);
        if (modeChanged) this._syncPicker();
        this._syncSetupRow();
      });
      this.appendChild(this._form);
    }
    this._updateSchema();
    if (this._hass) this._form.hass = this._hass;
    this._syncPicker();
    this._syncSetupRow();
  }

  // One-click join-script setup: creates a generic server-side script via
  // the config API and wires it into the card config. Admin only.
  _syncSetupRow() {
    if (!this._config) return;
    if (!this._setupRow) {
      this._setupRow = document.createElement('div');
      this._setupRow.innerHTML = `
        <style>
          .setup-row { margin-top: 12px; padding: 12px; border: 1px dashed var(--divider-color, #ccc);
            border-radius: 8px; }
          .setup-row button { background: var(--primary-color, #03a9f4); color: #fff; border: none;
            border-radius: 18px; padding: 8px 16px; font-weight: 500; cursor: pointer; }
          .setup-row button[disabled] { opacity: .4; cursor: default; }
          .setup-txt { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 8px; }
          .setup-status { font-size: 12px; margin-top: 8px; color: var(--primary-color); }
        </style>
        <div class="setup-row">
          <div class="setup-txt" data-ref="txt"></div>
          <button data-ref="btn">Create join script</button>
          <div class="setup-status" data-ref="status"></div>
        </div>`;
      this._setupRow
        .querySelector('[data-ref="btn"]')
        .addEventListener('click', () => this._createJoinScript());
      this.appendChild(this._setupRow);
    }
    const scriptEntity = `script.${HEOS_JOIN_SCRIPT_ID}`;
    const exists = this._hass && this._hass.states[scriptEntity];
    const isAdmin = this._hass && this._hass.user && this._hass.user.is_admin;
    const configured = !!this._config.join_script;
    const txt = this._setupRow.querySelector('[data-ref="txt"]');
    const btn = this._setupRow.querySelector('[data-ref="btn"]');
    const status = this._setupRow.querySelector('[data-ref="status"]');
    if (configured && (this._config.join_script !== scriptEntity || exists)) {
      txt.textContent = 'Join script configured — rooms will join reliably, even from analogue sources (turntable/CD).';
      btn.style.display = 'none';
    } else if (exists) {
      txt.textContent = 'A join script already exists — click to use it for reliable analogue-source streaming.';
      btn.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Use existing join script';
    } else {
      txt.textContent =
        'Recommended: create a small server-side script so rooms reliably start playing when joined from analogue sources (turntable/CD). One click, no YAML.';
      btn.style.display = '';
      btn.disabled = !isAdmin;
      btn.textContent = isAdmin ? 'Create join script' : 'Create join script (admin users only)';
    }
    status.textContent = this._setupStatus;
  }

  async _createJoinScript() {
    const scriptEntity = `script.${HEOS_JOIN_SCRIPT_ID}`;
    try {
      if (!this._hass.states[scriptEntity]) {
        this._setupStatus = 'Creating script…';
        this._syncSetupRow();
        await this._hass.callApi(
          'post',
          `config/script/config/${HEOS_JOIN_SCRIPT_ID}`,
          HEOS_JOIN_SCRIPT_CONFIG
        );
      }
      const config = { ...this._config, join_script: scriptEntity };
      this._config = config;
      this._emit(config);
      this._setupStatus = `Done — ${scriptEntity} created and configured.`;
    } catch (err) {
      this._setupStatus = `Failed: ${(err && err.message) || err}`;
    }
    this._render();
  }

  _syncPicker() {
    if (this._mode === 'theme') {
      if (!this._picker) {
        this._picker = document.createElement('heos-theme-picker');
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
    // Keep the setup row last in the editor.
    if (this._setupRow) this.appendChild(this._setupRow);
  }

  _updateSchema(current) {
    const g = this._config.gradient;
    const players = (current && current.players) || this._players();
    const friendly = (id) => {
      const s = this._hass && this._hass.states[id];
      return (s && s.attributes && s.attributes.friendly_name) || id;
    };
    const defaultLeader =
      (current && current.default_leader) ||
      this._config.default_leader ||
      this._config.entity ||
      players[0] ||
      '';
    const schema = [
      {
        name: 'players',
        label: 'Players (leader candidates + rooms)',
        required: true,
        selector: { entity: { domain: 'media_player', multiple: true } },
      },
    ];
    if (players.length > 1) {
      schema.push({
        name: 'default_leader',
        label: 'Default leader',
        selector: {
          select: {
            mode: 'dropdown',
            options: players.map((p) => ({ value: p, label: friendly(p) })),
          },
        },
      });
    }
    schema.push(
      { name: 'name', label: 'Card title (optional)', selector: { text: {} } },
      {
        name: 'join_script',
        label: 'Join script (optional — created by the button below)',
        selector: { entity: { domain: 'script' } },
      }
    );
    // Per-leader source filters: one multi-select per player, shown only
    // when that player leads. HEOS lists every input on every player, so
    // this is how users keep each leader's dropdown to its own inputs.
    players.forEach((p, i) => {
      const ps = this._hass && this._hass.states[p];
      const opts = (ps && ps.attributes && ps.attributes.source_list) || [];
      if (opts.length) {
        schema.push({
          name: `src_${i}`,
          label: `Sources shown when ${friendly(p)} leads (optional filter)`,
          selector: {
            select: { multiple: true, mode: 'dropdown', options: opts },
          },
        });
      }
      schema.push({
        name: `avr_${i}`,
        label: `Receiver entity for ${friendly(p)} (optional — adds power + sound modes)`,
        selector: { entity: { domain: 'media_player' } },
      });
      const avrEnt = (this._config.avr_entities || {})[p];
      const avrState = avrEnt && this._hass ? this._hass.states[avrEnt] : null;
      const modeOpts =
        (avrState && avrState.attributes && avrState.attributes.sound_mode_list) || [];
      if (modeOpts.length) {
        schema.push({
          name: `smf_${i}`,
          label: `Sound modes shown for ${friendly(p)} (optional filter — hide modes the receiver ignores)`,
          selector: {
            select: { multiple: true, mode: 'dropdown', options: modeOpts },
          },
        });
      }
    });
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
    const data = {
      players,
      default_leader: defaultLeader,
      name: (current && current.name) || this._config.name || '',
      join_script: (current && current.join_script) || this._config.join_script || '',
      mode: this._mode,
      theme: (current && current.theme) || this._config.theme || '',
      gradient_from: (current && current.gradient_from) || (Array.isArray(g) ? g[0] : ''),
      gradient_to: (current && current.gradient_to) || (Array.isArray(g) ? g[1] : ''),
    };
    const cfgS = this._config.sources;
    players.forEach((p, i) => {
      let pre = [];
      if (cfgS && typeof cfgS === 'object' && !Array.isArray(cfgS)) pre = cfgS[p] || [];
      else if (Array.isArray(cfgS)) pre = cfgS;
      data[`src_${i}`] = (current && current[`src_${i}`]) || pre;
      data[`avr_${i}`] =
        (current && current[`avr_${i}`]) || (this._config.avr_entities || {})[p] || '';
      data[`smf_${i}`] =
        (current && current[`smf_${i}`]) || (this._config.sound_modes || {})[p] || [];
    });
    this._form.data = data;
  }
}

customElements.define('heos-multiroom-card', HeosMultiroomCard);
customElements.define('heos-multiroom-card-editor', HeosMultiroomCardEditor);
customElements.define('heos-theme-picker', HeosThemePicker);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'heos-multiroom-card',
  name: 'HEOS Multiroom Card',
  preview: true,
  documentationURL: 'https://github.com/mycrouch/heos-multiroom-card',
  description:
    'One-card HEOS multi-room audio: switchable group leader with per-leader source lists, per-room join toggles, per-device volume and mute (mute the leader locally while it streams to rooms), optional receiver power + sound-mode controls via a linked AVR entity, and one-click setup of a server-side join script for reliable analogue-source streaming.',
});

console.info(
  `%c HEOS-MULTIROOM-CARD %c v${HEOS_CARD_VERSION} `,
  'color: white; background: #03a9f4; font-weight: 700;',
  'color: #03a9f4; background: white; font-weight: 700;'
);
