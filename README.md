# AMP Multi-room Card

One-card multi-room audio control for Home Assistant, built for a HEOS group leader (e.g. a Denon AVR playing a turntable or CD) streaming to HEOS room speakers. Pick the AMP's source, add or remove rooms with a toggle, and control every volume — all rooms at once or each individually — without leaving the card.

Born of a real frustration: the HEOS app regularly forms a group from an analogue source but the follower never starts streaming, needing a remove/re-add and a manual play. This card pairs with a small Home Assistant script that automates that dance, so adding a room *just works*.

## Features

- **Source picker** — dropdown of the leader's sources, optionally filtered to the ones you actually use (hide that Cameras input).
- **Per-room join toggles** — flip a room on and it joins the AMP's group (via your join script for reliable analogue streaming, or plain `media_player.join`); flip it off to unjoin. Rows expand with controls only when a room is active.
- **All-rooms volume** — one slider that sets every current group member, alongside individual sliders for the AMP and each room.
- **Play/stop per room** — nudge a stubborn follower without opening the HEOS app.
- **GUI editor** — leader, rooms, source filter (populated live from the leader's `source_list`), join script, names, and styling all configurable without YAML.
- **Three style modes** — default (native theme), apply any installed theme to just this card (with gradient swatch picker), or manual gradient colours.

## Installation

### HACS (recommended)

1. HACS → three-dot menu → Custom repositories
2. Add `https://github.com/mycrouch/amp-multiroom-card` as type **Dashboard**
3. Search for "AMP Multi-room Card" and download
4. Hard-refresh your browser

### Manual

Download `amp-multiroom-card.js` to `/config/www/` and add it as a dashboard resource (`/local/amp-multiroom-card.js`, type module).

## Configuration

Everything is configurable in the GUI editor. YAML equivalent:

```yaml
type: custom:amp-multiroom-card
entity: media_player.denon_amp_2          # group leader (AMP)
name: AMP Multi-room                      # card title
amp_name: AMP (Lounge)                    # leader display name
rooms:
  - media_player.dining_room
  - media_player.master_bedroom
join_script: script.stream_amp_to_room    # optional but recommended
sources:                                  # optional filter of source_list
  - Turntable
  - CD
  - TV
room_names:                               # optional display overrides (YAML only)
  media_player.dining_room: Dining
```

| Option | Default | Description |
|---|---|---|
| `entity` | required | Group leader `media_player` (must support grouping) |
| `rooms` | `[]` | Room speakers offered as join toggles |
| `name` | `Multi-room Audio` | Card title |
| `amp_name` | leader's friendly name | Leader row label |
| `join_script` | none | Script called with `room:` to join reliably; falls back to `media_player.join` |
| `sources` | all | Subset/order of the leader's `source_list` to show |
| `room_names` | friendly names | Per-room display name overrides |
| `theme` | none | Apply an installed theme to this card only |
| `gradient` | none | `[from, to]` manual gradient colours |

### The join script

For network sources plain `media_player.join` is fine. For analogue sources (turntable/CD) HEOS followers often join silently; the companion script joins, verifies playback, presses play, and re-joins if needed. Example in [`examples/stream_amp_to_room.yaml`](examples/stream_amp_to_room.yaml).

## Notes

- Room join state is read from the leader's `group_members`, so groups formed in the HEOS app show correctly here too.
- HEOS speakers expose play/stop (not pause) for grouped analogue streams — the room button reflects that.
- The all-rooms slider sets each member to the same level (leader included).

## Related projects

| Repo | What it is |
|---|---|
| [airtouch-card](https://github.com/mycrouch/airtouch-card) | AirTouch 4/5 console-style AC + zone control |
| [sensibo-thermostat-card](https://github.com/mycrouch/sensibo-thermostat-card) | Thermostat-style Sensibo card |
| [ecovacs-vacuum-card](https://github.com/mycrouch/ecovacs-vacuum-card) | Ecovacs/Deebot control card |
| [gradient-themes](https://github.com/mycrouch/gradient-themes) | 40 gradient dashboard themes |

## License

MIT © Jason Crouch. Icons are Material Design Icons (Apache 2.0) rendered via `ha-icon`.
