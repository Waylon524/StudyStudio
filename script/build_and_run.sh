#!/bin/bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$MODE" in
  run|--verify|verify|--logs|logs|--telemetry|telemetry|--debug|debug|--build-only) ;;
  *) echo "usage: $0 [--verify|--logs|--telemetry|--debug|--build-only]" >&2; exit 2 ;;
esac

# Build first. Installation refuses a running app so unsent drafts are not lost.
cd "$ROOT_DIR"
npm run build -- --configLoader runner
if [[ "$MODE" == "--build-only" ]]; then
  /usr/bin/python3 "$ROOT_DIR/script/package_macos.py" --reuse-installed-native
  exit 0
fi
STUDY_UPDATE_DIR="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/study-studio-update.XXXXXX")"
trap '/bin/rm -rf -- "$STUDY_UPDATE_DIR"' EXIT
/usr/bin/python3 "$ROOT_DIR/script/package_macos.py" --reuse-installed-native --output "$STUDY_UPDATE_DIR"
/usr/bin/python3 "$ROOT_DIR/script/install_macos.py" "$STUDY_UPDATE_DIR/Study Studio.app" --clean-builds
/bin/rm -rf -- "$STUDY_UPDATE_DIR"
trap - EXIT

case "$MODE" in
  --logs|logs)
    /usr/bin/log stream --level info --style compact --predicate 'process == "StudyStudioApp"'
    ;;
  --telemetry|telemetry)
    /usr/bin/log stream --level info --style compact --predicate 'subsystem == "com.waylon.studystudio"'
    ;;
  --debug|debug)
    /usr/bin/lldb -n StudyStudioApp
    ;;
esac
