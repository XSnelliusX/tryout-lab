#!/usr/bin/env bash
# One command for a fresh Mac, nothing to clone first:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/XSnelliusX/tryout-lab/main/mac-setup/bootstrap.sh)"
# Installs the Xcode Command Line Tools (they bring git) if missing, clones the repo into
# ${TRYOUT_LAB_DIR:-~/tryout_lab} (a clean clone is updated with a fast-forward pull), then runs
# mac-setup/setup.sh. Arguments go to setup.sh: bash -c "$(curl ...)" bootstrap --dry-run
# Standalone on purpose: it runs before the repo, and lib.sh, exist on this machine.
set -euo pipefail

repo_url="https://github.com/XSnelliusX/tryout-lab.git"
dir="${TRYOUT_LAB_DIR:-$HOME/tryout_lab}"

[ "$(uname -s)" = Darwin ] || { echo "macOS only"; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "Apple Silicon only (Homebrew paths assume /opt/homebrew)"; exit 1; }

if xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools: already installed"
else
  xcode-select --install || true
  echo "Finish the Command Line Tools installer dialog that just opened, I will wait."
  until xcode-select -p >/dev/null 2>&1; do sleep 5; done
fi

if [ -d "$dir/.git" ]; then
  if [ -z "$(git -C "$dir" status --porcelain)" ]; then
    git -C "$dir" pull --ff-only || echo "could not fast-forward $dir, using it as it is"
  else
    echo "$dir has local changes, using it as it is"
  fi
elif [ ! -e "$dir" ] || [ -z "$(ls -A "$dir")" ]; then
  git clone "$repo_url" "$dir"
else
  echo "$dir exists and is not a git checkout, using it as it is"
fi
[ -f "$dir/mac-setup/setup.sh" ] || { echo "no mac-setup/setup.sh in $dir"; exit 1; }

exec bash "$dir/mac-setup/setup.sh" "$@" </dev/tty
