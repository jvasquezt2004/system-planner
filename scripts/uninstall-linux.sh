#!/usr/bin/env bash
set -euo pipefail

# Ensure script is run on Linux
if [ "$(uname -s)" != "Linux" ]; then
	echo "Error: This uninstaller is intended for Linux only." >&2
	exit 1
fi

XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$XDG_DATA_HOME/schema-designer"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/schema-designer"
APPLICATIONS_DIR="$XDG_DATA_HOME/applications"
DESKTOP_FILE="$APPLICATIONS_DIR/schema-designer.desktop"
ALT_DESKTOP_FILE="$APPLICATIONS_DIR/SchemaDesigner.desktop"
ICON_THEME_DIR="$XDG_DATA_HOME/icons/hicolor"

echo "==> Removing Schema Designer application..."
rm -rf "$APP_DIR"

echo "==> Removing launcher script..."
rm -f "$LAUNCHER"

echo "==> Removing desktop entries..."
rm -f "$DESKTOP_FILE" "$ALT_DESKTOP_FILE"

echo "==> Removing desktop icons..."
rm -f "$ICON_THEME_DIR/scalable/apps/schema-designer.svg"
for size in 16 24 32 48 64 128 256 512; do
	rm -f "$ICON_THEME_DIR/${size}x${size}/apps/schema-designer.png"
done

echo "==> Updating desktop database and icon cache..."
if command -v update-desktop-database >/dev/null 2>&1; then
	update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
	gtk-update-icon-cache -f -t -q "$ICON_THEME_DIR" >/dev/null 2>&1 || true
fi

echo ""
echo "Schema Designer was successfully uninstalled."
echo ""
echo "Note: User data and credentials were NOT deleted."
echo "Your data remains safe at:"
echo "  Database (stable): $XDG_DATA_HOME/com.dbplanner.schema-designer/stable/schema-designer.sqlite"
echo "  Database (dev):    $XDG_DATA_HOME/com.dbplanner.schema-designer/dev/schema-designer.sqlite"
echo "  Credentials:       stored in the system keyring / secret service"
