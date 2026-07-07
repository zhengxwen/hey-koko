#!/bin/zsh
# Build LocalAIChat.app macOS bundle
set -e

APP_NAME="hey-koko"
BUNDLE_ID="com.hey-koko-app.loca-ai-chat"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${SRC_DIR}/${APP_NAME}.app"
CONTENTS="${APP_DIR}/Contents"
MACOS="${CONTENTS}/MacOS"
RESOURCES="${CONTENTS}/Resources"
APP_FILES="${RESOURCES}/app"

echo "Building ${APP_NAME}.app ..."

# Clean previous build
rm -rf "${APP_DIR}"

# Create directory structure
mkdir -p "${MACOS}" "${RESOURCES}" "${APP_FILES}"

# ─── Generate .icns icon ───────────────────────────────────────────
ICONSET="${RESOURCES}/icon.iconset"
mkdir -p "${ICONSET}"

# Convert SVG to PNG using sips (needs intermediate PNG via /usr/bin/qlmanage or python)
ICON_SVG="${SRC_DIR}/app-icon.svg"
ICON_PNG="/tmp/${APP_NAME}_icon_1024.png"

# Use python3 to render SVG to PNG (available on macOS by default via cairosvg or we use a simpler method)
if command -v rsvg-convert &>/dev/null; then
  rsvg-convert -w 1024 -h 1024 "${ICON_SVG}" -o "${ICON_PNG}"
elif command -v python3 &>/dev/null; then
  # Use qlmanage as fallback for SVG to PNG
  qlmanage -t -s 1024 -o /tmp "${ICON_SVG}" 2>/dev/null && mv "/tmp/app-icon.svg.png" "${ICON_PNG}"
fi

if [[ -f "${ICON_PNG}" ]]; then
  # Generate all required sizes
  for size in 16 32 64 128 256 512 1024; do
    sips -z $size $size "${ICON_PNG}" --out "${ICONSET}/icon_${size}x${size}.png" >/dev/null 2>&1
  done
  # Also create @2x versions
  sips -z 32 32 "${ICON_PNG}" --out "${ICONSET}/icon_16x16@2x.png" >/dev/null 2>&1
  sips -z 64 64 "${ICON_PNG}" --out "${ICONSET}/icon_32x32@2x.png" >/dev/null 2>&1
  sips -z 256 256 "${ICON_PNG}" --out "${ICONSET}/icon_128x128@2x.png" >/dev/null 2>&1
  sips -z 512 512 "${ICON_PNG}" --out "${ICONSET}/icon_256x256@2x.png" >/dev/null 2>&1
  sips -z 1024 1024 "${ICON_PNG}" --out "${ICONSET}/icon_512x512@2x.png" >/dev/null 2>&1

  iconutil -c icns "${ICONSET}" -o "${RESOURCES}/icon.icns"
  rm -rf "${ICONSET}" "${ICON_PNG}"
  echo "  ✓ Icon generated"
else
  echo "  ⚠ Could not render SVG to PNG. App will use default icon."
  echo "    Install librsvg (brew install librsvg) for better icon support."
  rm -rf "${ICONSET}"
fi

# ─── Copy project files ───────────────────────────────────────────
cp "${SRC_DIR}/server.js" "${APP_FILES}/"
cp -R "${SRC_DIR}/server" "${APP_FILES}/server"
cp -R "${SRC_DIR}/public" "${APP_FILES}/public"
echo "  ✓ Project files copied"

# ─── Compile Swift native app ─────────────────────────────────────
swiftc "${SRC_DIR}/AppMain.swift" \
  -o "${MACOS}/hey-koko" \
  -framework Cocoa \
  -framework WebKit \
  -O \
  -target arm64-apple-macos11.3
echo "  ✓ Native app compiled"

# ─── Create Info.plist ────────────────────────────────────────────
cat > "${CONTENTS}/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>Local AI Chat</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleExecutable</key>
  <string>hey-koko</string>
  <key>CFBundleIconFile</key>
  <string>icon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSUIElement</key>
  <false/>
</dict>
</plist>
PLIST
echo "  ✓ Info.plist created"

# ─── Ad-hoc code sign ─────────────────────────────────────────────
# Apple Silicon requires every bundle to be signed (at minimum ad-hoc), or
# macOS rejects it with "damaged or incomplete". Copying files in after the
# compile also invalidates the linker's implicit signature, so sign the whole
# bundle LAST. "-" = ad-hoc (no Developer ID needed).
codesign --force --deep --sign - "${APP_DIR}" >/dev/null 2>&1 \
  && echo "  ✓ Ad-hoc signed" \
  || echo "  ⚠ codesign failed — the app may not open until signed"
# Strip the quarantine flag in case the bundle picked one up.
xattr -dr com.apple.quarantine "${APP_DIR}" 2>/dev/null || true

echo ""
echo "✅ ${APP_NAME}.app built successfully!"
echo "   Location: ${APP_DIR}"
echo ""
echo "You can now:"
echo "  • Double-click ${APP_NAME}.app to launch"
echo "  • Drag it to /Applications for permanent install"
echo "  • Drag it to the Dock for quick access"
