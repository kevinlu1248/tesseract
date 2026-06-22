#!/bin/sh
# Dev-only: the macOS menu-bar app title is read from the running bundle's
# CFBundleName, which for the dev Electron binary is "Electron". app.setName()
# can't override it at runtime, so we patch the dev bundle's Info.plist. Runs as
# a `predev` step; a no-op on non-macOS or if the bundle isn't present. Packaged
# builds get the right name from package.json `productName` and don't need this.
PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
[ -f "$PLIST" ] || exit 0
/usr/libexec/PlistBuddy -c "Set :CFBundleName Tesseract" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Tesseract" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Tesseract" "$PLIST" 2>/dev/null || true
exit 0
