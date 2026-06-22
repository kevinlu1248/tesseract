#!/bin/sh
# Dev-only: the macOS menu-bar app title is read from the running bundle's
# CFBundleName, which for the dev Electron binary is "Electron". app.setName()
# can't override it at runtime, so we patch the dev bundle's Info.plist. Runs as
# a `predev` step; a no-op on non-macOS or if the bundle isn't present. Packaged
# builds get the right name from package.json `productName` and don't need this.
BUNDLE="node_modules/electron/dist/Electron.app"
PLIST="$BUNDLE/Contents/Info.plist"
[ -f "$PLIST" ] || exit 0
/usr/libexec/PlistBuddy -c "Set :CFBundleName Tesseract" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Tesseract" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Tesseract" "$PLIST" 2>/dev/null || true

# The Cmd+Tab switcher reads the app icon from the bundle's CFBundleIconFile
# (electron.icns), which app.dock.setIcon() (runtime, Dock-only) doesn't touch.
# Build an .icns from build/icon.png and overwrite the dev bundle's icon so the
# switcher shows the Tesseract mark. Needs sips + iconutil (stock on macOS).
ICON_SRC="build/icon.png"
ICNS="$BUNDLE/Contents/Resources/electron.icns"
if [ -f "$ICON_SRC" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  TMP=$(mktemp -d) && ISET="$TMP/icon.iconset" && mkdir -p "$ISET" && (
    for s in 16 32 128 256 512; do
      sips -z $s $s "$ICON_SRC" --out "$ISET/icon_${s}x${s}.png" >/dev/null 2>&1
      d=$((s * 2))
      sips -z $d $d "$ICON_SRC" --out "$ISET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
    done
    iconutil -c icns "$ISET" -o "$TMP/icon.icns" 2>/dev/null && cp "$TMP/icon.icns" "$ICNS" 2>/dev/null
  )
  rm -rf "$TMP" 2>/dev/null || true
fi

# Patching Info.plist isn't enough: LaunchServices caches the bundle's name and
# icon (keyed on the bundle dir, whose mtime predates our edits), so Cmd+Tab /
# the Dock keep showing the stale "Electron". Bump the bundle mtime and force a
# re-register so the switcher picks up "Tesseract" and the new icon.
touch "$BUNDLE" 2>/dev/null || true
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$BUNDLE" 2>/dev/null || true
exit 0
