#!/usr/bin/env bash
set -euo pipefail

# Ensure script is run on Linux
if [ "$(uname -s)" != "Linux" ]; then
	echo "Error: This installer is intended for Linux only." >&2
	exit 1
fi

# Locate repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check prerequisites
if ! command -v hutch >/dev/null 2>&1; then
	if [ -x "$HOME/.hutch/bin/hutch" ]; then
		PATH="$HOME/.hutch/bin:$PATH"
	else
		echo "Error: 'hutch' is required to build Schema Designer but was not found in PATH." >&2
		echo "Please install Hutch and ensure it is on your PATH (or in ~/.hutch/bin)." >&2
		exit 1
	fi
fi

if ! command -v rsvg-convert >/dev/null 2>&1; then
	echo "Error: 'rsvg-convert' is required to generate application icons from SVG." >&2
	echo "Please install librsvg (e.g. 'sudo pacman -S librsvg' on Arch, 'sudo apt install librsvg2-bin' on Debian/Ubuntu, or 'sudo dnf install librsvg2-tools' on Fedora)." >&2
	exit 1
fi

SVG_ICON="$REPO_ROOT/assets/brand/schema-designer.svg"
if [ ! -f "$SVG_ICON" ]; then
	echo "Error: Brand icon not found at $SVG_ICON" >&2
	exit 1
fi

echo "==> Generating brand PNG for Electrobun build..."
rsvg-convert -w 512 -h 512 "$SVG_ICON" -o "$REPO_ROOT/assets/brand/schema-designer.png"

echo "==> Building Schema Designer (stable channel)..."
(cd "$REPO_ROOT" && hutch run build)

BUILD_DIR="$REPO_ROOT/build/stable-linux-x64/SchemaDesigner"
if [ ! -d "$BUILD_DIR" ]; then
	echo "Error: Build output directory not found at $BUILD_DIR" >&2
	exit 1
fi

XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$XDG_DATA_HOME/schema-designer"
BIN_DIR="$HOME/.local/bin"
APPLICATIONS_DIR="$XDG_DATA_HOME/applications"
ICON_THEME_DIR="$XDG_DATA_HOME/icons/hicolor"

mkdir -p "$XDG_DATA_HOME" "$BIN_DIR" "$APPLICATIONS_DIR"

STAGE_DIR="$(mktemp -d "$XDG_DATA_HOME/schema-designer.staging.XXXXXX")"
BACKUP_DIR="$(mktemp -d "$XDG_DATA_HOME/schema-designer.old.XXXXXX")"
rm -rf "$BACKUP_DIR"

cleanup() {
	rm -rf "$STAGE_DIR" "$BACKUP_DIR"
}
trap cleanup EXIT

echo "==> Staging application files..."
PAYLOAD_ARCHIVE=$(find "$BUILD_DIR/Resources" -maxdepth 1 -name "*.tar.zst" 2>/dev/null | head -n 1 || true)
if [ -n "$PAYLOAD_ARCHIVE" ] && [ -f "$PAYLOAD_ARCHIVE" ]; then
	tar --zstd -xf "$PAYLOAD_ARCHIVE" --strip-components=1 -C "$STAGE_DIR"
else
	cp -a "$BUILD_DIR/." "$STAGE_DIR/"
fi

chmod -R u+w "$STAGE_DIR"
chmod +x "$STAGE_DIR/bin/"* 2>/dev/null || true

echo "==> Installing app atomically to $APP_DIR..."
if [ -d "$APP_DIR" ]; then
	mv "$APP_DIR" "$BACKUP_DIR"
fi
mv "$STAGE_DIR" "$APP_DIR"
rm -rf "$BACKUP_DIR"

echo "==> Creating launcher at $BIN_DIR/schema-designer..."
LAUNCHER="$BIN_DIR/schema-designer"
cat > "$LAUNCHER" << 'EOF'
#!/bin/sh
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/schema-designer"
exec "$DATA_DIR/bin/launcher" "$@"
EOF
chmod +x "$LAUNCHER"

echo "==> Installing hicolor icons..."
mkdir -p "$ICON_THEME_DIR/scalable/apps"
cp "$SVG_ICON" "$ICON_THEME_DIR/scalable/apps/schema-designer.svg"

for size in 16 24 32 48 64 128 256 512; do
	size_dir="$ICON_THEME_DIR/${size}x${size}/apps"
	mkdir -p "$size_dir"
	rsvg-convert -w "$size" -h "$size" "$SVG_ICON" -o "$size_dir/schema-designer.png"
done

echo "==> Writing desktop shortcut to $APPLICATIONS_DIR/schema-designer.desktop..."
DESKTOP_FILE="$APPLICATIONS_DIR/schema-designer.desktop"
cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Type=Application
Name=Schema Designer
Comment=Design relational database schemas and sandbox changes
Exec=$LAUNCHER
Icon=schema-designer
Terminal=false
StartupWMClass=SchemaDesigner
Categories=Development;Database;
EOF
chmod 644 "$DESKTOP_FILE"

# Remove any raw Electrobun desktop file if present from earlier extractor runs
rm -f "$APPLICATIONS_DIR/SchemaDesigner.desktop"

echo "==> Updating desktop database and icon cache..."
if command -v update-desktop-database >/dev/null 2>&1; then
	update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
	gtk-update-icon-cache -f -t -q "$ICON_THEME_DIR" >/dev/null 2>&1 || true
fi

echo ""
echo "Schema Designer successfully installed!"
echo "  Installed app:  $APP_DIR"
echo "  Launcher:       $LAUNCHER"
echo "  Desktop entry:  $DESKTOP_FILE"
echo "  Icon theme:     $ICON_THEME_DIR"
echo ""
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
	echo "Note: $BIN_DIR is not currently in your PATH."
	echo "Add 'export PATH=\"\$HOME/.local/bin:\$PATH\"' to your ~/.bashrc or ~/.zshrc."
fi
