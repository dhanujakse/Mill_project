#!/usr/bin/env bash
# Mill Mate - build and open the iPhone app on a Mac.
#
#   First time:   git clone https://github.com/ramya25-star/Mill_project.git && cd Mill_project
#   Every time:   bash ios-mac.sh
#
# Gets the latest code, installs packages, builds the app and opens Xcode.
# In Xcode: pick an iPhone simulator at the top and press Run (no iPhone or
# Apple account needed), or Product > Archive to upload to TestFlight.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mSTOPPED: %s\033[0m\n' "$1" >&2; exit 1; }

say "1/5 Checking tools"
command -v xcodebuild >/dev/null || fail "Xcode is not installed. Install it from the Mac App Store, open it once, then run this again."
xcode-select -p >/dev/null 2>&1 || fail "Run: sudo xcode-select -s /Applications/Xcode.app"
command -v node >/dev/null || fail "Node.js is not installed. Install Node 22 LTS from https://nodejs.org and run this again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node $NODE_MAJOR is too old. Install Node 22 LTS from https://nodejs.org."
echo "    Xcode: $(xcodebuild -version | head -1), Node: $(node -v)"

say "2/5 Getting the latest code"
if [ -n "$(git status --porcelain)" ]; then
  echo "    Local changes found - keeping them and skipping git pull."
else
  git pull --ff-only
fi

say "3/5 Installing packages"
npm ci --no-audit --no-fund

say "4/5 Building the app (production server: api.alagiriduplex.com)"
npm run build

say "5/5 Copying it into the iOS project"
# Always sync iOS here on the Mac: syncing on Windows writes Windows-style
# paths into ios/App/CapApp-SPM/Package.swift that Xcode can't read.
npx cap sync ios

VERSION="$(grep -m1 'MARKETING_VERSION' ios/App/App.xcodeproj/project.pbxproj | sed 's/[^0-9.]//g')"
BUILD="$(grep -m1 'CURRENT_PROJECT_VERSION' ios/App/App.xcodeproj/project.pbxproj | sed 's/[^0-9]//g')"
printf '\n\033[1;32mReady: Mill Mate %s (build %s). Opening Xcode...\033[0m\n' "$VERSION" "$BUILD"
echo "  Test:    pick an iPhone simulator at the top, press Run."
echo "  Upload:  choose 'Any iOS Device (arm64)', then Product > Archive > Distribute App > App Store Connect."
npx cap open ios
