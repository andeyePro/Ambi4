#!/usr/bin/env bash
# Every browser drive, in one command — with the honesty the sweep needed.
#
#   npm run build && tests/sweep-drives.sh
#   tests/sweep-drives.sh tests/dial-drive.mjs tests/undo-drive.mjs   # a subset
#
# WHY THIS EXISTS (audit, 2026-07-31). Running the drives one after another by
# hand produced seven failures in a row of 28 — and all seven passed
# immediately when run alone. The drives are honest individually; the SWEEP was
# not, because their waits are tuned for an idle Mac and a loaded one misses
# them. A sweep that cries wolf is a sweep that stops being run (the same law
# the layout sweep's own comments state), so this script separates the two
# outcomes instead of averaging them:
#
#   RED    failed in the sweep AND failed again alone → a real regression.
#          Exit code 1. This is the only thing that fails the gate.
#   FLAKY  failed in the sweep, passed alone → timing under load. Listed
#          loudly, never silently swallowed, but does not fail the gate.
#
# A cooldown between drives keeps the Mac from queueing renders behind each
# other, which is what most of the load came from. Override with
# SWEEP_COOLDOWN=<seconds> (default 3); SWEEP_SOLO_COOLDOWN=<seconds> (default
# 20, the rest before a solo re-run); SWEEP_RETRY=0 turns the solo re-run off
# entirely, which makes every in-suite failure RED — use that when you want the
# strictest possible reading.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

COOLDOWN="${SWEEP_COOLDOWN:-3}"
# The rest before a solo re-run: long enough that the re-run is not measuring
# the same load that failed the drive in the first place.
SOLO_COOLDOWN="${SWEEP_SOLO_COOLDOWN:-20}"
RETRY="${SWEEP_RETRY:-1}"

if [ ! -d dist ]; then
  echo "no ./dist — run npm run build first" >&2
  exit 1
fi

if [ "$#" -gt 0 ]; then
  DRIVES=("$@")
else
  # Discovered, not listed: a new drive is swept the day it lands. The three
  # offline render harnesses (onset-render, call-breath-render,
  # wash-sweep-render) are drives too — they run in the same browser.
  mapfile -t DRIVES < <(ls tests/*-drive.mjs tests/*-render.mjs 2>/dev/null | sort)
fi

run_one() {
  # Prints the drive's own tail; returns its exit status.
  .vibe/measure.sh local drive "$1" 2>&1 | tail -40
  return "${PIPESTATUS[0]}"
}

green=()
flaky=()
red=()

for drive in "${DRIVES[@]}"; do
  name="$(basename "$drive")"
  printf '%-26s ' "$name"
  if out="$(run_one "$drive")"; then
    passed="$(printf '%s' "$out" | grep -oE '"(passed|asserted)": [0-9]+' | head -1)"
    echo "ok    ${passed:-(no count)}"
    green+=("$name")
  else
    echo 'failed in sweep — re-running alone…'
    if [ "$RETRY" = "0" ]; then
      red+=("$name")
      printf '%s\n' "$out" | sed 's/^/    /'
    else
      # v0.0.142: the solo re-run waits LONGER than the between-drive cooldown.
      # A three-second gap is not enough for a Mac that has just run thirty
      # browser drives back to back, so the re-run inherits the same load that
      # caused the failure and the split calls a load flake RED — which is the
      # cry-wolf failure this runner exists to prevent, and it did it twice on
      # submit-drive, which passes solo on a quiet machine every time.
      sleep "$SOLO_COOLDOWN"
      if solo="$(run_one "$drive")"; then
        echo "                           FLAKY (green alone)"
        flaky+=("$name")
      else
        # Twice, with the longer wait between: a drive that fails a rested
        # re-run as well is a regression, not a machine having a bad minute.
        sleep "$SOLO_COOLDOWN"
        if solo="$(run_one "$drive")"; then
          echo "                           FLAKY (green on a second rested run)"
          flaky+=("$name")
        else
          echo "                           RED (failed alone twice, rested)"
          red+=("$name")
          printf '%s\n' "$solo" | sed 's/^/    /'
        fi
      fi
    fi
  fi
  sleep "$COOLDOWN"
done

echo
echo "${#green[@]} green, ${#flaky[@]} flaky, ${#red[@]} red, of ${#DRIVES[@]} drives"
[ "${#flaky[@]}" -gt 0 ] && echo "FLAKY (passed alone — load, not regression): ${flaky[*]}"
if [ "${#red[@]}" -gt 0 ]; then
  echo "RED (failed alone twice, rested — fix before shipping): ${red[*]}"
  exit 1
fi
exit 0
