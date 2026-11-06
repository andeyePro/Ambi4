#!/usr/bin/env bash
# Run Chromium drives inside Firefox or WebKit on the Mac test account.
#
#   tests/sweep-engines.sh firefox                 # the default list below
#   tests/sweep-engines.sh webkit dial undo         # named drives (no -drive.mjs)
#
# WHY: every drive runs in the harness's headless Chromium, and the app had
# never been opened in Firefox until 2026-11-06. Re-hosting the same drives in
# the other two engines found, the same day: a Firefox-only reverb leak
# (v0.0.297), Firefox and Safari starting every visit at the Low power tier
# (v0.0.301), Safari losing focus out of every popover after a click
# (v0.0.302), and a drive red in every browser that nobody had re-run.
#
# HOW: a drive is shipped to the Mac as ONE file, so each is wrapped — its
# default export renamed, and a new default that launches the other engine,
# opens the same URL, waits for the app, and hands that page to the drive.
# The wrappers live in a temporary directory and are removed afterwards.
# Firefox is told to Tab to every control (accessibility.tabfocus 7);
# WebKit's plain Tab reaches form fields only, as Safari's does, so a drive
# that walks buttons with Tab fails there by design (keyboard-only-drive
# carries its own three-engine loop with Option+Tab instead).
#
# Needs the engines installed on the test account:
#   cd ~/shot && npx playwright install webkit firefox
# AMBI4_SHOT_SLOT (default 7) keeps it off the slot tests/sweep-drives.sh uses.
set -euo pipefail

ENGINE="${1:?usage: tests/sweep-engines.sh <firefox|webkit> [drive ...]}"
shift
case "$ENGINE" in
  firefox) LAUNCH="__pw.firefox.launch({ firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false, 'accessibility.tabfocus': 7 } })" ;;
  webkit) LAUNCH="__pw.webkit.launch()" ;;
  *) echo "engine must be firefox or webkit" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Green in both engines on v0.0.302 (2026-11-06), so a red here is news.
DEFAULT=(chordchip create dial first-visit genre-rules play-along popover presets
  registry-dial share-browser spread-all structure-edges transport typed-beat
  typed-melody undo undo-everywhere user-genre user-voice voices-edges words)
if [ "$#" -gt 0 ]; then DRIVES=("$@"); else DRIVES=("${DEFAULT[@]}"); fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
export AMBI4_SHOT_SLOT="${AMBI4_SHOT_SLOT:-7}"

green=0; red=0; reds=()
for name in "${DRIVES[@]}"; do
  src="$ROOT/tests/${name}-drive.mjs"
  [ -f "$src" ] || { echo "no such drive: $src" >&2; red=$((red + 1)); reds+=("$name"); continue; }
  out="$TMP/${name}-${ENGINE}-drive.mjs"
  {
    echo "import { join as __j } from 'node:path';"
    echo "import { pathToFileURL as __u } from 'node:url';"
    echo "const __pw = await import(__u(__j(process.cwd(), 'node_modules', 'playwright', 'index.mjs')).href);"
    sed 's/^export default async function drive(\([a-zA-Z]*\)) {/async function __inner(\1) {/' "$src"
    cat <<EOT
export default async function drive(harnessPage) {
  const url = harnessPage.url();
  const b = await ${LAUNCH};
  try {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(800);
    return await __inner(page);
  } finally { await b.close(); }
}
EOT
  } > "$out"
  printf '%-26s ' "$name"
  if result="$("$ROOT/.vibe/measure.sh" local drive "$out" 2>&1)" && printf '%s' "$result" | grep -q '^{'; then
    green=$((green + 1)); echo "ok    $(printf '%s' "$result" | grep -o '"passed": [0-9]*' | head -1)"
  else
    red=$((red + 1)); reds+=("$name"); echo "RED"
    printf '%s\n' "$result" | grep -E '✗|got|want|Error' | head -12 | sed 's/^/      /'
  fi
done

echo
echo "$ENGINE: $green green, $red red, of ${#DRIVES[@]} drives"
[ "$red" -eq 0 ] || { echo "RED: ${reds[*]}"; exit 1; }
