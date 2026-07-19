/*
 * HEOS Multiroom Card v1.2.1
 * https://github.com/mycrouch/heos-multiroom-card
 *
 * One-card multi-room audio for HEOS: pick a group leader from your pool of
 * players (any HEOS unit with a physical input can lead — AVR turntable,
 * a speaker's AUX/USB), toggle rooms in and out of the group, and control
 * every volume — all rooms at once or each individually. Pairs with a small
 * server-side join script (one-click creation from the card editor) that
 * works around HEOS's silent-follower bug on analogue sources.
 *
 * MIT License — Jason Crouch. Icons: Material Design Icons via ha-icon.
 */

const HEOS_CARD_VERSION = '1.2.1';
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
    // v1.2 config: players + default_leader. Back-compat with v1.0/1.1
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
    this._userLeader = null; // manual pick on the card, session-scoped
    this._builtLeader = null;
    this._built = false;
    this._errorShown = false;
    this._showSources = false;
    this._showLeaders = false;
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
        `${id}:${s.state}:${a.source || ''}:${a.volume_level ?? ''}:${(a.group_members || []).join(',')}`
      );
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
    const filter = this._config.sources;
    if (Array.isArray(filter) && filter.length) {
      const filtered = filter.filter((s) => all.includes(s));
      // The filter is leader-specific; if it matches nothing on this
      // leader (e.g. leader switched from AVR to a speaker), show all.
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

  _setGroupVolume(leader, pct) {
    const members = this._groupMembers(leader);
    const targets = members.length ? members : [leader];
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

    const roomRows = rooms
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
          ha-card.grad .title, ha-card.grad .room-name, ha-card.grad .leader-name { color: #fff; }
          ha-card.grad .sub, ha-card.grad .vol-pct, ha-card.grad .vol-ic, ha-card.grad .leader-caret { color: rgba(255,255,255,0.72); }
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
            max-height: min(65vh, 440px); overflow: auto; overscroll-behavior: contain; }
          .dropdown-menu.left { right: auto; left: 0; top: 26px; }
          .dropdown-item { padding: 10px 16px; cursor: pointer; font-size: 14px; color: var(--primary-text-color); white-space: nowrap; }
          .dropdown-item:hover { background: var(--secondary-background-color, #f2f2f2); }
          .dropdown-item.selected { color: var(--primary-color); font-weight: 600; }
          .vol-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
          .vol-ic { --mdc-icon-size: 18px; color: var(--secondary-text-color); flex: none; }
          input[type=range].vol { flex: 1; accent-color: var(--primary-color, #03a9f4); height: 22px; margin: 0; min-width: 0; }
          .vol-pct { font-size: 12px; color: var(--secondary-text-color); width: 34px; text-align: right; flex: none; }
          .leader-block { margin-top: 14px; position: relative; }
          .leader-head { display: inline-flex; align-items: center; gap: 4px; ${multiLeader ? 'cursor: pointer;' : ''} }
          .leader-name { font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
          .leader-caret { --mdc-icon-size: 16px; color: var(--secondary-text-color); ${multiLeader ? '' : 'display: none;'} }
          .leader-tag { font-size: 11px; color: var(--secondary-text-color); margin-left: 4px; }
          .group-row { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--divider-color, #e0e0e0); }
          .group-name { font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
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
          <div class="leader-block">
            <span class="leader-head" data-ref="leader-head">
              <span class="leader-name" data-ref="leader-name"></span>
              <span class="leader-tag">leader</span>
              <ha-icon class="leader-caret" icon="mdi:chevron-down"></ha-icon>
            </span>
            <div data-ref="leader-menu"></div>
            <div class="vol-row">
              <ha-icon class="vol-ic" icon="mdi:volume-medium"></ha-icon>
              <input type="range" min="0" max="100" step="1" class="vol" data-ref="leader-vol" data-entity="${leader}">
              <span class="vol-pct" data-ref="leader-pct"></span>
            </div>
          </div>
          <div class="group-row" data-ref="group-row" style="display:none;">
            <div class="group-name">All rooms</div>
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
      this._showLeaders = false;
      this._renderSourceMenu(leader);
      this._renderLeaderMenu(leader);
    });

    // Leader dropdown
    if (multiLeader) {
      this._els['leader-head'].addEventListener('click', (e) => {
        e.stopPropagation();
        this._showLeaders = !this._showLeaders;
        this._showSources = false;
        this._renderLeaderMenu(leader);
        this._renderSourceMenu(leader);
      });
    }

    if (this._outside) document.removeEventListener('click', this._outside, true);
    this._outside = (e) => {
      if ((this._showSources || this._showLeaders) && !e.composedPath().includes(this)) {
        this._showSources = false;
        this._showLeaders = false;
        this._renderSourceMenu(leader);
        this._renderLeaderMenu(leader);
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
        if (entity === '__group__') this._setGroupVolume(leader, pct);
        else this._setVolume(entity, pct);
      });
    });

    // Room toggles and play/stop
    rooms.forEach((room, i) => {
      const toggle = this._els[`toggle-${i}`];
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        if (this._isJoined(leader, room)) this._unjoinRoom(room);
        else this._joinRoom(leader, room);
        toggle.checked = !this._isJoined(leader, room);
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

  _updateDynamic(leader) {
    const l = this._hass.states[leader];
    const attrs = (l && l.attributes) || {};
    const rooms = this._rooms(leader);

    this._setText(this._els['src-sub'], attrs.source || '—');
    if (this._showSources) this._renderSourceMenu(leader);

    this._setText(this._els['leader-name'], this._displayName(leader));
    this._patchSlider('leader-vol', 'leader-pct', leader, attrs.volume_level);

    const joinedRooms = rooms.filter((r) => this._isJoined(leader, r));
    this._els['group-row'].style.display = joinedRooms.length ? '' : 'none';
    if (joinedRooms.length) {
      const vols = [leader, ...joinedRooms]
        .map((e) => {
          const s = this._hass.states[e];
          return s && s.attributes ? s.attributes.volume_level : undefined;
        })
        .filter((v) => typeof v === 'number');
      const avg = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
      this._patchSlider('group-vol', 'group-pct', '__group__', avg);
    }

    rooms.forEach((room, i) => {
      const row = this.querySelector(`.room-row[data-room="${CSS.escape(room)}"]`);
      const s = this._hass.states[room];
      const joined = this._isJoined(leader, room);
      this._setText(this._els[`name-${i}`], this._displayName(room));
      if (row) row.classList.toggle('off', !joined);
      const toggle = this._els[`toggle-${i}`];
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
    const pctRef =
      ref === 'leader-vol' ? 'leader-pct' : ref === 'group-vol' ? 'group-pct' : ref.replace('vol-', 'pct-');
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

  _renderLeaderMenu(leader) {
    const container = this._els['leader-menu'];
    if (!container) return;
    if (!this._showLeaders) {
      if (container.innerHTML !== '') container.innerHTML = '';
      return;
    }
    container.innerHTML = `<div class="dropdown-menu left">
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
    if (Array.isArray(v.sources) && v.sources.length) config.sources = v.sources;
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
    // Source options from the default leader's live source_list.
    const leaderState =
      this._hass && defaultLeader ? this._hass.states[defaultLeader] : null;
    const sourceOptions =
      (leaderState && leaderState.attributes && leaderState.attributes.source_list) || [];
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
      players,
      default_leader: defaultLeader,
      name: (current && current.name) || this._config.name || '',
      join_script: (current && current.join_script) || this._config.join_script || '',
      sources: (current && current.sources) || this._config.sources || [],
      mode: this._mode,
      theme: (current && current.theme) || this._config.theme || '',
      gradient_from: (current && current.gradient_from) || (Array.isArray(g) ? g[0] : ''),
      gradient_to: (current && current.gradient_to) || (Array.isArray(g) ? g[1] : ''),
    };
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
    'One-card HEOS multi-room audio: switchable group leader with source picker, per-room join toggles, individual + all-rooms volume and play/stop, and one-click setup of a server-side join script for reliable analogue-source streaming.',
});

console.info(
  `%c HEOS-MULTIROOM-CARD %c v${HEOS_CARD_VERSION} `,
  'color: white; background: #03a9f4; font-weight: 700;',
  'color: #03a9f4; background: white; font-weight: 700;'
);
