#!/usr/bin/env bash
# Shared helpers for setup.sh and the installers in cmux/ and claude-code/. Sourced, never run.
# Plain bash 3.2 (macOS /bin/bash). A file that gets replaced is copied to $BACKUP_DIR first,
# never next to the original. Nothing here deletes a file.

DRY_RUN="${DRY_RUN:-0}"; export DRY_RUN
# One backup folder per run: setup.sh exports it, so the installers it calls share it.
# It is created only when something is actually backed up.
BACKUP_DIR="${SETUP_BACKUP_DIR:-$HOME/.setup_backup/$(date +%Y%m%d-%H%M%S)}"; export SETUP_BACKUP_DIR="$BACKUP_DIR"

have() { command -v "$1" >/dev/null 2>&1; }
dry() { [ "$DRY_RUN" = 1 ]; }
# gum widgets only in a real terminal (SETUP_PLAIN=1 forces the plain prompts); gum draws on stderr, answers go to stdout ($(...) captures them)
ui() { [ "${SETUP_PLAIN:-0}" != 1 ] && have gum && [ -t 0 ] && [ -t 2 ]; }
bold() {
  if ui; then echo; gum style --bold "==> $*"; else printf '\n\033[1m==> %s\033[0m\n' "$*"; fi
}
info() { printf '    %s\n' "$*"; }
run() { # run <command...>: runs it, or only says so in a dry run
  if dry; then info "would run: $*"; else "$@"; fi
}
ask() { # ask <question> [default y|n]
  local def="${2:-y}" hint reply rc=0
  if ui; then
    gum confirm --default="$([ "$def" = y ] && echo true || echo false)" "$1" || rc=$?
    [ "$rc" -le 1 ] || exit "$rc"   # 130 is Ctrl+C: stop the script
    return "$rc"
  fi
  [ "$def" = y ] && hint="Y/n" || hint="y/N"
  read -r -p "    $1 [$hint] " reply || reply=""
  reply="${reply:-$def}"
  [[ "$reply" =~ ^[Yy] ]]
}
input() { # input <prompt> [default]; prints the answer, Enter takes the default
  local v
  if ui; then gum input --prompt "$1 " --value "${2:-}"; return; fi
  read -r -p "    $1${2:+ [$2]}: " v || v=""
  printf '%s\n' "${v:-${2:-}}"
}
secret() { # secret <prompt>; prints what is typed, never echoed
  local v
  if ui; then gum input --password --prompt "$1 "; return; fi
  read -r -s -p "    $1: " v || v=""; echo >&2
  printf '%s\n' "$v"
}
choose() { # choose <header> <names preselected> <item>...; prints the chosen items
  # An item is "name  text": the name is its first word. Item texts must not contain commas (gum splits on them).
  local header="$1" presel="$2" item n st tog on sel=""
  shift 2
  if ui; then
    for item in "$@"; do n="${item%% *}"; case " $presel " in *" $n "*) sel="${sel:+$sel,}$item" ;; esac; done
    gum choose --no-limit --height=25 --header="$header" --selected="$sel" "$@"
    return
  fi
  printf '    %s\n' "$header" >&2
  for item in "$@"; do
    n="${item%% *}"; on=" "
    case " $presel " in *" $n "*) on=x ;; esac
    printf '    [%s] %s\n' "$on" "$item" >&2
  done
  read -r -p "    Names to toggle, space separated (Enter keeps the [x] ones): " tog || tog=""
  for item in "$@"; do
    n="${item%% *}"; st=0
    case " $presel " in *" $n "*) st=1 ;; esac
    case " $tog " in *" $n "*) st=$((1 - st)) ;; esac
    if [ "$st" = 1 ]; then printf '%s\n' "$item"; fi
  done
  return 0
}
pick() { # pick <header> <default key> <key:label>...: sets PICKED to the chosen key (the default on Enter or Esc)
  local header="$1" def="$2" kv k reply="" rc=0 labels=() hint="" ch deflabel=""
  shift 2
  for kv in "$@"; do
    k="${kv%%:*}"; labels+=("${kv#*:}")
    if [ "$k" = "$def" ]; then deflabel="${kv#*:}"; hint="$hint/$(printf '%s' "$k" | tr a-z A-Z)"; else hint="$hint/$k"; fi
  done
  hint="${hint#/}"
  PICKED="$def"
  if ui; then
    # --selected puts the cursor on the default, so Enter means the same as in the plain prompt
    reply="$(gum choose --header="$header" --selected="$deflabel" "${labels[@]}")" || rc=$?
    [ "$rc" -le 1 ] || exit "$rc"   # 130 is Ctrl+C: stop the script
    for kv in "$@"; do
      if [ "${kv#*:}" = "$reply" ]; then PICKED="${kv%%:*}"; fi
    done
  else
    read -r -p "    $header [$hint] " reply || reply=""
    ch="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
    if [ -n "$ch" ]; then
      for kv in "$@"; do
        k="${kv%%:*}"
        if [ "${ch:0:1}" = "$k" ]; then PICKED="$k"; fi
      done
    fi
  fi
  return 0
}
page() { # reads a diff on stdin: gum pager in a gum session, less in a terminal, plain otherwise
  if ui; then gum pager; elif [ -t 1 ] && have less; then less -R; else cat; fi
}

backup_dst() { # where <path> goes in $BACKUP_DIR: mirrored under $HOME, or under _root/ for paths outside it
  case "$1" in
    "$HOME"/*) printf '%s/%s\n' "$BACKUP_DIR" "${1#"$HOME"/}" ;;
    *) printf '%s/_root%s\n' "$BACKUP_DIR" "$1" ;;
  esac
}
backup() { # backup <path>: copy a file or a folder into $BACKUP_DIR; nothing when the path does not exist
  local dst
  [ -e "$1" ] || return 0
  dst="$(backup_dst "$1")"
  mkdir -p "$(dirname "$dst")"
  if [ -d "$1" ]; then cp -Rp "$1" "$dst"; else cp -p "$1" "$dst"; fi
}
move_aside() { # move_aside <path>: move a file or a folder into $BACKUP_DIR (where backup puts it)
  local dst
  dst="$(backup_dst "$1")"
  mkdir -p "$(dirname "$dst")"
  mv "$1" "$dst"
  info "moved $1 -> $dst"
}
diffstat() { # diffstat <old> <new>: "+N/-M lines", what <new> adds and drops
  local out
  out="$(diff "$1" "$2" 2>/dev/null | awk '/^>/{p++} /^</{m++} END{ if (p + m == 0) print "differs"; else printf "+%d/-%d lines", p, m }')" || true
  printf '%s' "$out"
}
skip_file() { # skip_file <relpath> [pattern...]: true for files that are never synced
  local rel="$1" pat
  shift
  case "$rel" in .DS_Store|*/.DS_Store|__pycache__/*|*/__pycache__/*) return 0 ;; esac
  for pat in "$@"; do
    case "$rel" in $pat|*/$pat) return 0 ;; esac
  done
  return 1
}

install_file() { # install_file <src> <dst>: missing -> copy; same -> nothing; different -> ask (overwrite, show diff, skip)
  local src="$1" dst="$2"
  if [ ! -e "$dst" ]; then
    if dry; then info "would create $dst"; return 0; fi
    mkdir -p "$(dirname "$dst")"; cat "$src" > "$dst"; info "new $dst"; return 0   # cat: the new file gets the normal mode, not the temp file mode
  fi
  if cmp -s "$src" "$dst"; then info "unchanged $dst"; return 0; fi
  if dry; then info "would update $dst ($(diffstat "$dst" "$src"))"; return 0; fi
  while :; do
    pick "$dst differs from the repo ($(diffstat "$dst" "$src"))" s "o:Overwrite" "d:Show diff" "s:Skip"
    case "$PICKED" in
      o) backup "$dst"; cat "$src" > "$dst"; info "updated $dst (the old file is in $(backup_dst "$dst"))"; return 0 ;;
      d) diff -u "$dst" "$src" | page || true ;;
      *) info "kept $dst"; return 0 ;;
    esac
  done
}

copy_list() { # copy_list <srcdir> <dstdir> <relpaths, one per line>: write them, backing up the files they replace
  local src="$1" dst="$2" rel
  while IFS= read -r rel; do
    if [ -z "$rel" ]; then continue; fi
    if [ -e "$dst/$rel" ]; then
      backup "$dst/$rel"; info "updated $dst/$rel (the old file is in $(backup_dst "$dst/$rel"))"
    else
      info "new $dst/$rel"
    fi
    mkdir -p "$(dirname "$dst/$rel")"; cp "$src/$rel" "$dst/$rel"
  done <<< "$3"
}
install_tree() { # install_tree <srcdir> <dstdir> [pattern...]: sync a folder. New files are copied, changed ones are
  # asked about once. Files that only exist in dst are kept. Patterns and skip_file's rules leave files out.
  local src="$1" dst="$2" rel news="" chgs="" nnew=0 nchg=0 items=() picked="" line names
  shift 2
  if [ ! -d "$src" ]; then info "$src is missing, nothing to install"; return 0; fi
  while IFS= read -r rel; do
    rel="${rel#./}"
    if skip_file "$rel" "$@"; then continue; fi
    if [ ! -e "$dst/$rel" ]; then
      news="$news$rel"$'\n'; nnew=$((nnew + 1))
    elif ! cmp -s "$src/$rel" "$dst/$rel"; then
      chgs="$chgs$rel"$'\n'; nchg=$((nchg + 1))
    fi
  done < <(cd "$src" && find . -type f | sort)
  if [ $((nnew + nchg)) -eq 0 ]; then info "up to date $dst"; return 0; fi
  info "$dst: $nnew new, $nchg changed"
  while IFS= read -r rel; do
    if [ -n "$rel" ]; then info "  new     $rel"; fi
  done <<< "$news"
  while IFS= read -r rel; do
    if [ -n "$rel" ]; then info "  changed $rel ($(diffstat "$dst/$rel" "$src/$rel"))"; fi
  done <<< "$chgs"
  if dry; then info "would write the files above (dry run)"; return 0; fi
  if [ "$nchg" -eq 0 ]; then copy_list "$src" "$dst" "$news"; return 0; fi   # only new files: nothing is overwritten
  while IFS= read -r rel; do
    if [ -n "$rel" ]; then items+=("$rel"); fi
  done <<< "$news$chgs"
  while :; do
    pick "Overwrite the changed files in $dst?" s "a:Overwrite all" "d:Show diff" "p:Pick files" "s:Skip"
    case "$PICKED" in
      a) copy_list "$src" "$dst" "$news$chgs"; return 0 ;;
      d) { while IFS= read -r rel; do
             if [ -n "$rel" ]; then diff -u "$dst/$rel" "$src/$rel" || true; fi
           done <<< "$chgs"; } | page || true ;;
      p) names="$(choose "Files to write into $dst" "" "${items[@]}")"
         picked=""
         while IFS= read -r line; do
           if [ -n "$line" ]; then picked="$picked${line%% *}"$'\n'; fi
         done <<< "$names"
         copy_list "$src" "$dst" "$picked"; return 0 ;;
      *) info "kept $dst"; return 0 ;;
    esac
  done
}
