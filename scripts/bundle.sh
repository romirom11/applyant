#!/bin/bash
# Builds Applyant.app and installs it in /Applications (for this Mac only: ad-hoc signed,
# not notarised). A locally built app isn't quarantined, so Gatekeeper doesn't ask.
#
#   scripts/bundle.sh [--no-install] [--no-open]
#
#   Applyant.app/Contents/
#   ├── MacOS/Applyant · MacOS/applyantd        the menu bar app · what launchd starts
#   ├── Helpers/applyant-native                 the Swift helper (Keychain, PDFKit, wake)
#   ├── PlugIns/ApplyantShare.appex             the Share extension (sandboxed; Share → Applyant)
#   ├── Resources/node/bin/node                 the official Node, darwin-arm64
#   ├── Resources/daemon/                       daemon/src + production node_modules (hoisted)
#   └── Resources/bin/applyant                  the CLI launcher (symlinked to ~/.local/bin)
#
# Needs Xcode, and Node 24 + pnpm (the daemon's versions) on PATH.
set -euo pipefail

INSTALL=1
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --no-install) INSTALL=0 ;;
    --no-open) OPEN=0 ;;
    *) echo "usage: $0 [--no-install] [--no-open]" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
CACHE="$BUILD/cache"
APP="$BUILD/Applyant.app"
C="$APP/Contents"
DEST="/Applications/Applyant.app"

step() { printf '\n==> %s\n' "$*"; }

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "builds on Apple silicon macOS only" >&2; exit 1; }
NODE_VERSION="$(node --version)"
case "$NODE_VERSION" in v24.*|v2[5-9].*) ;; *) echo "needs Node >= 24 on PATH (found $NODE_VERSION)" >&2; exit 1 ;; esac

mkdir -p "$CACHE"
rm -rf "$APP" "$BUILD/stage"

step "Node $NODE_VERSION (official darwin-arm64 build)"
NODE_DIST="node-$NODE_VERSION-darwin-arm64"
NODE_TGZ="$CACHE/$NODE_DIST.tar.gz"
if [ ! -f "$NODE_TGZ" ]; then
  curl -fsSL -o "$NODE_TGZ.part" "https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST.tar.gz"
  curl -fsSL -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  expected="$(grep " $NODE_DIST.tar.gz\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | cut -d' ' -f1)"
  actual="$(shasum -a 256 "$NODE_TGZ.part" | cut -d' ' -f1)"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "Node checksum mismatch" >&2; rm -f "$NODE_TGZ.part"; exit 1; }
  mv "$NODE_TGZ.part" "$NODE_TGZ"
fi
mkdir -p "$C/Resources/node/bin"
tar -xzf "$NODE_TGZ" -C "$BUILD" "$NODE_DIST/bin/node" "$NODE_DIST/LICENSE"
mv "$BUILD/$NODE_DIST/bin/node" "$C/Resources/node/bin/node"
mv "$BUILD/$NODE_DIST/LICENSE" "$C/Resources/node/LICENSE"
rm -rf "${BUILD:?}/$NODE_DIST"

step "Swift: applyant-native, the app and its launcher (release)"
swift build -c release --package-path "$ROOT/native" --arch arm64
swift build -c release --package-path "$ROOT/app" --arch arm64
NATIVE_BIN="$(swift build -c release --package-path "$ROOT/native" --arch arm64 --show-bin-path)"
APP_BIN="$(swift build -c release --package-path "$ROOT/app" --arch arm64 --show-bin-path)"
mkdir -p "$C/MacOS" "$C/Helpers"
cp "$APP_BIN/Applyant" "$APP_BIN/applyantd" "$C/MacOS/"
cp "$NATIVE_BIN/applyant-native" "$C/Helpers/"
# SwiftPM can't make an .appex: its executable goes into the bundle an extension needs.
APPEX="$C/PlugIns/ApplyantShare.appex"
mkdir -p "$APPEX/Contents/MacOS"
cp "$APP_BIN/ApplyantShare" "$APPEX/Contents/MacOS/"

step "Daemon: sources + production node_modules"
STAGE="$BUILD/stage/daemon"
mkdir -p "$STAGE"
cp "$ROOT/daemon/package.json" "$ROOT/daemon/pnpm-lock.yaml" "$ROOT/daemon/pnpm-workspace.yaml" "$STAGE/"
rsync -a --exclude '*.test.ts' "$ROOT/daemon/src" "$STAGE/"
# Hoisted: a flat node_modules without symlinks, so it copies and signs like plain files.
(cd "$STAGE" && pnpm install --prod --frozen-lockfile --config.node-linker=hoisted --ignore-scripts=false >/dev/null)
# Native binaries for other platforms never run here.
find "$STAGE/node_modules/onnxruntime-node/bin" -mindepth 2 -maxdepth 2 -type d ! -name darwin -exec rm -rf {} + 2>/dev/null || true
find "$STAGE/node_modules/onnxruntime-node/bin" -path '*/darwin/x64' -type d -exec rm -rf {} + 2>/dev/null || true
# The Agent SDK's own `claude` build (~200 MB): the daemon always passes the candidate's
# signed-in CLI (cli-paths.ts), and without this the SDK can't silently fall back to it.
rm -rf "$STAGE"/node_modules/@anthropic-ai/claude-agent-sdk-darwin-*
# Likewise the Codex SDK's own `codex` build (~130 MB): the daemon always passes the
# candidate's signed-in CLI as codexPathOverride.
rm -rf "$STAGE"/node_modules/@openai/codex-darwin-* "$STAGE"/node_modules/@openai/codex-linux-* \
  "$STAGE"/node_modules/@openai/codex-win32-*
rm -f "$STAGE/pnpm-lock.yaml" "$STAGE/pnpm-workspace.yaml"
mv "$STAGE" "$C/Resources/daemon"

step "CLI launcher, Info.plist"
mkdir -p "$C/Resources/bin"
cat > "$C/Resources/bin/applyant" <<'SH'
#!/bin/sh
# applyant: the CLI on the Node bundled in Applyant.app (the same code as the daemon).
self="$0"
while [ -L "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
res="$(cd "$(dirname "$self")/.." && pwd)"
exec "$res/node/bin/node" "$res/daemon/src/cli/index.ts" "$@"
SH
chmod 755 "$C/Resources/bin/applyant"
BUILD_NUMBER="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
sed "s/__BUILD__/$BUILD_NUMBER/" "$ROOT/app/Bundle/Info.plist" > "$C/Info.plist"
printf 'APPL????' > "$C/PkgInfo"
cp "$ROOT/app/Bundle/AppIcon.icns" "$C/Resources/AppIcon.icns"
plutil -lint "$C/Info.plist" >/dev/null
sed "s/__BUILD__/$BUILD_NUMBER/" "$ROOT/app/Bundle/ShareExtension-Info.plist" > "$APPEX/Contents/Info.plist"
printf 'XPC!????' > "$APPEX/Contents/PkgInfo"
plutil -lint "$APPEX/Contents/Info.plist" >/dev/null

step "Ad-hoc signing: every Mach-O inside out, the app last"
sign() { codesign --force --sign - --timestamp=none "$@"; }
count=0
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q 'Mach-O'; then
    sign "$f"
    count=$((count + 1))
  fi
done < <(find "$C/Resources/daemon" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' -o -perm -u+x \) -print0)
echo "signed $count native modules in node_modules"
sign "$C/Resources/node/bin/node"
# Keychain items trust the helper by its designated requirement. Ad-hoc, that defaults to the
# binary's hash, so every rebuild would ask "allow access?"; by identifier, a rebuilt helper
# reads what the last one stored.
sign --identifier com.applyant.native -r='designated => identifier "com.applyant.native"' \
  "$C/Helpers/applyant-native"
sign --identifier com.applyant.daemon "$C/MacOS/applyantd"
# The extension before the app that contains it, with its sandbox entitlements.
sign --identifier com.applyant.app.share --entitlements "$ROOT/app/Bundle/ShareExtension.entitlements" "$APPEX"
sign --identifier com.applyant.app "$APP"
codesign --verify --deep --strict "$APP"
du -sh "$APP" | sed 's/^/size: /'

[ "$INSTALL" = 1 ] || { echo "built $APP (not installed)"; exit 0; }

step "Install to $DEST"
pkill -x Applyant 2>/dev/null && sleep 1 || true
rm -rf "$DEST"
ditto "$APP" "$DEST"
codesign --verify --deep --strict "$DEST"
# The CLI on PATH (~/.local/bin is where claude lives too). An existing non-link is left alone.
LINK="$HOME/.local/bin/applyant"
mkdir -p "$HOME/.local/bin"
if [ ! -e "$LINK" ] || [ -L "$LINK" ]; then
  ln -sfn "$DEST/Contents/Resources/bin/applyant" "$LINK"
  echo "CLI: $LINK"
else
  echo "warning: $LINK exists and isn't a symlink; left alone" >&2
fi
# The daemon launchd runs is still on the old files: restart it on the new ones. (On a first
# install the app writes the agent and starts it.)
# Launch Services (and so Notification Center and the Dock) keep the icon they first saw: tell
# them about this build, so a changed icon shows in notifications too.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$DEST" || true
if launchctl print "gui/$(id -u)/com.applyant.daemon" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/com.applyant.daemon"
  echo "restarted the running daemon"
fi
if [ "$OPEN" = 1 ]; then
  open "$DEST"
else
  echo "note: launch the app once (open $DEST) so it installs the daemon's launch agent"
fi
echo "installed $DEST"
