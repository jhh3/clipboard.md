#!/usr/bin/env bash
#
# Turn a programmable keypad's keys into modifier combos, per device.
#
# WHY A DAEMON AND NOT udev/hwdb: hwdb can only map one keycode to one other
# keycode, so it cannot produce "Ctrl+Alt+Shift+D" at all. It is also the wrong layer
# — remapping to F13..F24 looks free but is not: this machine's pc105 XKB layout
# rewrites F13-F18 into XF86Tools/XF86Launch5-9 and F20-F23 into mic-mute and
# touchpad keys, so a "spare" function key silently opens Settings instead. Only F19
# and F24 survive untranslated, which is not enough for a board. keyd works below
# XKB, matches by USB vendor:product, and emits real combos — nothing to collide with
# and nothing to be rewritten.
#
# WHY THIS IS DEVICE-SCOPED: the pad emits ordinary keycodes. Binding the key it
# currently sends would also bind that key on your real keyboard, because GNOME
# matches keycodes and has no idea which device produced them. keyd does.
#
# Run:  sudo ./scripts/setup-macropad.sh
set -euo pipefail

VENDOR=8089      # SayoDevice
PRODUCT=0009     # O3C
CONF=/etc/keyd/sayodevice.conf

if [[ $EUID -ne 0 ]]; then
  echo "This needs root (it installs a daemon and writes /etc/keyd)." >&2
  echo "Run: sudo $0" >&2
  exit 1
fi

# A leftover keycode remap would fight the daemon: hwdb rewrites the scancode before
# keyd ever sees it, so keyd would be matching a key the pad no longer sends.
STALE=/etc/udev/hwdb.d/61-sayodevice-o3c.hwdb
if [[ -f "$STALE" ]]; then
  echo "==> Removing the old hwdb keycode remap (it conflicts with keyd)"
  rm -f "$STALE"
  systemd-hwdb update && udevadm trigger --subsystem-match=input --action=change
fi

echo "==> Installing keyd"
if ! command -v keyd >/dev/null; then
  apt-get install -y keyd
else
  echo "    already installed"
fi

# keyd takes the device exclusively (EVIOCGRAB), so the original keys stop leaking
# through — which is exactly what we want: no stray 'z' reaching applications.
echo
echo "==> Finding out what each key currently sends"
echo "    keyd monitor prints every key as you press it."
echo "    Press each key on the pad ONE AT A TIME, then press Ctrl+C."
echo
sleep 1
# Only this device, and only the key names — keyd prints "<device>\t<key> down".
timeout 30 keyd monitor 2>/dev/null | grep --line-buffered -iE "sayo" || true

echo
echo "==> Writing $CONF"
mkdir -p /etc/keyd
# The [ids] section is what makes this device-scoped: only this vendor:product is
# grabbed, so your main keyboard is completely untouched.
#
# Ctrl+Alt+Shift is chosen because it is empty on a stock GNOME desktop apart from
# Escape, Tab and the arrow keys — so letters in that space cannot collide. Combos
# also have no special keysym for XKB to rewrite, which is the trap that F13 fell into.
cat > "$CONF" <<EOF
[ids]
${VENDOR}:${PRODUCT}

[main]
# left column = the key the pad currently sends (from keyd monitor above)
# right column = what it should send instead
#
# C = Ctrl, A = Alt, S = Shift, M = Super. C-A-S-d is Ctrl+Alt+Shift+D.
z = C-A-S-d
x = C-A-S-v
c = C-A-S-n
EOF
echo "    wrote:"; sed 's/^/      /' "$CONF"

echo
echo "==> Starting keyd"
systemctl enable --now keyd
systemctl restart keyd
sleep 1
systemctl --no-pager --lines=5 status keyd || true

cat <<'DONE'

==> Done.

If the key names above (z / x / c) do not match what `keyd monitor` printed, edit
/etc/keyd/sayodevice.conf, then:  sudo systemctl restart keyd

Check it worked:   sudo keyd monitor      # the pad should now report the combos
Then in clipboard.md: Settings -> General -> Hold-to-talk chord -> press pad key 1.
It should record Ctrl+Alt+Shift+D.

Bind the other two in GNOME Settings -> Keyboard -> Custom Shortcuts, or leave them
for clipboard.md to pick up.

To undo everything:
  sudo systemctl disable --now keyd && sudo rm /etc/keyd/sayodevice.conf
DONE
