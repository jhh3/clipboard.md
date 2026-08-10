# clipboard.md — one documented way to do each thing.
#
# This exists because the app was being started by hand in slightly different ways
# (different environments, stray instances left running, DISPLAY overridden for a
# debugging session), and each variation broke something real: a blanked DISPLAY
# takes out clipboard capture and paste, because clipboard I/O is X11-based.
#
# Use these targets. `make help` lists them.

SHELL := /bin/bash
ELECTRON := $(shell ls -d node_modules/.pnpm/electron@*/node_modules/electron/dist/electron 2>/dev/null | head -1)
APPDIR := $(CURDIR)
UNIT := clipboard-md
LOG := $(HOME)/.config/clipboard.md/logs/main-$(shell date +%F).log

APP := $(HOME)/.local/bin/clipboard.md.AppImage
APP_UNIT := clipboard-md-app

# The display environment the app cannot work without, taken from the SESSION rather
# than from whoever ran make.
#
# `systemd-run --user` forwards the caller's environment, not the graphical session's.
# Run make from a shell without these — an agent, cron, ssh — and the app starts
# blind: clipboard I/O is X11 (xclip), so with no DISPLAY every copy and paste dies
# while the app otherwise looks perfectly healthy. Portal keystroke injection is
# D-Bus and keeps working, so the log even reports "injected via portal" for pastes
# that go nowhere. Pulling these from `systemctl --user show-environment` makes the
# launch identical no matter who starts it.
SESSION_ENV = $$(systemctl --user show-environment 2>/dev/null \
	| grep -E '^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|GNOME_SETUP_DISPLAY)=' \
	| sed 's/^/--setenv=/')

# Refuse to start blind rather than start something subtly broken.
define require_display
	@systemctl --user show-environment 2>/dev/null | grep -q '^DISPLAY=' || { \
		echo "no DISPLAY in the systemd user environment — is a graphical session running?"; \
		exit 1; }
endef

.PHONY: help build run stop restart status logs appimage install-appimage clean-instances doctor \
        app-run app-stop app-restart deploy

help:
	@echo "clipboard.md"
	@echo
	@echo "  make run          Build and (re)start the app in the background"
	@echo "  make stop         Stop it, including any strays"
	@echo "  make restart      stop + run"
	@echo "  make status       Is it running, on which backend, with what config"
	@echo "  make logs         Follow today's log"
	@echo "  make appimage     Build a double-clickable AppImage into dist/"
	@echo "  make doctor       Check the things that actually break on Linux"
	@echo
	@echo "  make deploy       Build, install and relaunch the AppImage  <- ship a fix"
	@echo "  make app-restart  Relaunch the installed AppImage"
	@echo "  make app-stop     Stop the installed AppImage"
	@echo
	@echo "Daily use is the AppImage. 'make run' is for working on the code."

build:
	pnpm build

# A transient systemd user unit, not a bare '&'. It survives the terminal closing,
# gets the real session environment (DISPLAY, WAYLAND_DISPLAY, DBUS), and its output
# lands in the journal. Crucially it does NOT override DISPLAY: clipboard capture and
# paste are X11-based and go silent without it.
run: build clean-instances
	$(require_display)
	@systemd-run --user --collect --unit=$(UNIT) $(SESSION_ENV) "$(APPDIR)/$(ELECTRON)" "$(APPDIR)" --background >/dev/null
	@sleep 3
	@$(MAKE) --no-print-directory status

stop: clean-instances
	@echo "stopped"

# Stray instances are their own bug: several running at once all poll the clipboard
# and write to the same SQLite file. Kill by exact binary path, never by a pkill
# pattern that can match the shell running it.
clean-instances:
	@systemctl --user stop $(UNIT) 2>/dev/null || true
	@systemctl --user reset-failed $(UNIT) 2>/dev/null || true
	@pids=$$(ps -eo pid,args | grep -F "$(APPDIR)" | grep -F "dist/electron" | grep -v "type=" | grep -v grep | awk '{print $$1}'); \
	if [ -n "$$pids" ]; then kill $$pids 2>/dev/null || true; sleep 2; kill -9 $$pids 2>/dev/null || true; fi

restart: stop run

status:
	@pid=$$(ps -eo pid,args | grep -F "$(APPDIR)" | grep -F "dist/electron --background" | grep -v grep | awk '{print $$1}' | head -1); \
	if [ -z "$$pid" ]; then echo "not running"; exit 1; fi; \
	echo "running        pid $$pid"; \
	echo "backend        $$(ps -eo args | grep -F "$(APPDIR)" | grep -oE 'ozone-platform=[a-z0-9]+' | sort -u | head -1)"; \
	echo "gpu            $$([ -f $(HOME)/.config/clipboard.md/force-software-gpu ] && echo 'software (flag set)' || echo 'hardware')"; \
	echo "dictation      $$(grep -E '\[dictate\] evdev' $(LOG) 2>/dev/null | tail -1 | sed 's/.*INFO //')"; \
	echo "capture        $$(grep -E '\[capture\]' $(LOG) 2>/dev/null | tail -1 | sed 's/.*\(INFO\|ERROR\) //')"

logs:
	@tail -f $(LOG)

appimage:
	pnpm build:linux
	@echo
	@ls -lh dist/*.AppImage
	@echo "Double-click it, or: chmod +x dist/*.AppImage && ./dist/clipboard.md-*.AppImage"

# Installs the AppImage somewhere stable and points the autostart entry at it, so a
# reboot brings back the same binary. A dev checkout must never be the login item:
# the pnpm store path changes on reinstall and the entry silently rots.
install-appimage: appimage
	@mkdir -p $(HOME)/.local/bin
# Write-then-rename, because a plain cp fails with "Text file busy": the MCP and
# bridge servers registered with Claude ARE this binary, so agents keep long-lived
# processes running it. rename() swaps the directory entry and leaves the old inode
# alive for them, so an upgrade never has to kill the user's agent sessions.
	@cp dist/clipboard.md-*.AppImage $(HOME)/.local/bin/.clipboard.md.AppImage.new
	@chmod +x $(HOME)/.local/bin/.clipboard.md.AppImage.new
	@mv -f $(HOME)/.local/bin/.clipboard.md.AppImage.new $(HOME)/.local/bin/clipboard.md.AppImage
	@echo "installed $(APP)"
	@echo "run it once and it registers its own autostart entry"

# Installing does not replace the copy already running — that was the missing step
# every time a fix "didn't work": the new binary was on disk and the old one was
# still on screen. This is the whole loop, so there is nothing left to remember.
deploy: install-appimage app-restart

# Every process that IS the app. An AppImage execs its payload out of a FUSE mount,
# so the running program is /tmp/.mount_clipboXXXXXX/clipboard-md and NOT the path you
# launched. Matching only the launcher killed a wrapper and left the app up; the next
# launch then lost the single-instance lock to it and exited in under a second, so a
# "restart" reported failure while the old build stayed on screen.
#
# --type= are Electron's own child processes (they go when the main one does).
# --mcp / --bridge are this same binary serving live agent sessions: never touch those.
APP_PIDS = $$(ps -eo pid,args --no-headers \
	| grep -E '(clipboard\.md\.AppImage|/tmp/\.mount_clipbo[^ ]*/clipboard-md)' \
	| grep -vE -- '--type=|--mcp|--bridge' \
	| awk '{print $$1}')

# Same transient-unit treatment as `run`, for the same reason: the real session
# environment, and never an overridden DISPLAY.
app-run:
	$(require_display)
	@systemd-run --user --collect --unit=$(APP_UNIT) $(SESSION_ENV) "$(APP)" --background >/dev/null
	@sleep 4
	@pid=$$(echo "$(APP_PIDS)" | head -1); \
	if [ -z "$$pid" ]; then echo "FAILED to start — make logs"; exit 1; fi; \
	echo "running        pid $$pid"; \
	tr '\0' '\n' < /proc/$$pid/environ | grep -q '^DISPLAY=' \
		&& echo "display        ok (clipboard I/O can reach X)" \
		|| { echo "display        MISSING — clipboard and paste will not work"; exit 1; }

app-stop:
	@systemctl --user stop $(APP_UNIT) 2>/dev/null || true
	@systemctl --user reset-failed $(APP_UNIT) 2>/dev/null || true
	@pids=$$(echo "$(APP_PIDS)"); \
	if [ -n "$$pids" ]; then kill $$pids 2>/dev/null || true; sleep 2; kill -9 $$pids 2>/dev/null || true; fi
	@echo "stopped        $(APP)"

app-restart: app-stop app-run

# The Linux-specific things that have actually broken, each checked directly.
doctor:
	@echo "session        $${XDG_SESSION_TYPE:-?} / $${XDG_CURRENT_DESKTOP:-?}"
	@echo "DISPLAY        $${DISPLAY:-(unset — clipboard capture and paste WILL fail)}"
	@echo "xclip          $$(command -v xclip || echo 'MISSING — clipboard I/O needs it')"
	@echo "ffmpeg         $$(command -v ffmpeg || echo 'MISSING — local transcription needs it')"
	@echo "claude         $$(command -v claude || echo 'MISSING — agent sessions need it on PATH')"
	@echo "tray extension $$(gnome-extensions list --enabled 2>/dev/null | grep -c appindicator) (0 = no tray icon on GNOME)"
	@echo "key repeat     $$(gsettings get org.gnome.desktop.peripherals.keyboard repeat 2>/dev/null) delay=$$(gsettings get org.gnome.desktop.peripherals.keyboard delay 2>/dev/null | grep -oE '[0-9]+$$') interval=$$(gsettings get org.gnome.desktop.peripherals.keyboard repeat-interval 2>/dev/null | grep -oE '[0-9]+$$')"
	@echo "               (repeat must be ON — it is the hold signal for push-to-talk)"
	@echo "gpu            $$([ -f $(HOME)/.config/clipboard.md/force-software-gpu ] && echo 'software; delete ~/.config/clipboard.md/force-software-gpu to retry hardware' || echo 'hardware')"
	@echo "instances      $$(ps -eo args | grep -F "$(APPDIR)" | grep -c 'dist/electron --background' || true) (more than 1 is a bug)"
