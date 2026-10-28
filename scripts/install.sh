#!/bin/sh
set -eu

REPOSITORY=9Ashwin/ShuaDouyin
NODE_VERSION=22.23.1
PNPM_VERSION=10.34.7
INSTALL_ROOT=${DY_INSTALL_HOME:-"$HOME/.local/share/shuadouyin"}
BIN_DIR=${DY_BIN_DIR:-"$HOME/.local/bin"}
SKILLS_DIR=${DY_SKILLS_DIR:-"$HOME/.agents/skills"}
SOURCE_DIR=
ACTION=install
STAGE=
LAUNCHER_TMP=
SKILL_TMP=
SWITCH_DIR=
SWITCH_OLD_TARGET=
REMOVE_DIR=
ROOT_LOCK=
BIN_LOCK=
SKILL_LOCK=
LOCK_TOKEN="dy-installer-$$"

usage() {
  cat <<'USAGE'
Install or update ShuaDouyin for the current user.

  sh install.sh                  Install or update
  sh install.sh --source PATH    Install from a local Git HEAD
  sh install.sh --uninstall      Remove the managed command and skill

Environment: DY_INSTALL_HOME, DY_BIN_DIR, DY_SKILLS_DIR, DY_INSTALL_SKILL=0
User state in ~/.dy is kept separate from the installation.
USAGE
}
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
notice() { printf '%s\n' "$*"; }
cleanup() {
  [ -z "$LAUNCHER_TMP" ] || rm -f "$LAUNCHER_TMP" || true
  [ -z "$SKILL_TMP" ] || rm -f "$SKILL_TMP" || true
  if [ -n "$SWITCH_DIR" ] && [ -d "$SWITCH_DIR" ] && [ ! -L "$SWITCH_DIR" ]; then
    if [ -n "$SWITCH_OLD_TARGET" ] && [ -L "$SWITCH_DIR/previous" ] &&
       [ "$(readlink "$SWITCH_DIR/previous" 2>/dev/null || true)" = "$SWITCH_OLD_TARGET" ] &&
       [ ! -e "$INSTALL_ROOT/current" ] && [ ! -L "$INSTALL_ROOT/current" ] &&
       ln -s "$SWITCH_OLD_TARGET" "$INSTALL_ROOT/current" 2>/dev/null; then
      rm -f "$SWITCH_DIR/previous" || true
      notice 'Restored the previous version after an interrupted switch.'
    fi
    if [ ! -e "$SWITCH_DIR/previous" ] && [ ! -L "$SWITCH_DIR/previous" ] &&
       [ -f "$SWITCH_DIR/.dy-switch-owner" ] && [ ! -L "$SWITCH_DIR/.dy-switch-owner" ] &&
       [ "$(cat "$SWITCH_DIR/.dy-switch-owner" 2>/dev/null || true)" = 'ShuaDouyin switch v1' ]; then
      rm -f "$SWITCH_DIR/.dy-switch-owner" || true
    fi
    rmdir "$SWITCH_DIR" 2>/dev/null || true
  fi
  if [ -n "$REMOVE_DIR" ] && [ -d "$REMOVE_DIR" ] && [ ! -L "$REMOVE_DIR" ]; then rmdir "$REMOVE_DIR" 2>/dev/null || true; fi
  if [ -n "$STAGE" ] && [ -d "$STAGE" ] && [ ! -L "$STAGE" ]; then rm -rf "$STAGE" || true; fi
  for lock in "$SKILL_LOCK" "$BIN_LOCK" "$ROOT_LOCK"; do
    [ -n "$lock" ] && [ ! -L "$lock" ] && [ -f "$lock/owner" ] && [ ! -L "$lock/owner" ] || continue
    if [ "$(cat "$lock/owner" 2>/dev/null || true)" = "$LOCK_TOKEN" ]; then
      rm -f "$lock/owner" || true
      rmdir "$lock" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) [ "$#" -ge 2 ] || fail '--source needs a directory'; SOURCE_DIR=$2; shift 2 ;;
    --uninstall) ACTION=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

for path in "$INSTALL_ROOT" "$BIN_DIR" "$SKILLS_DIR"; do
  case "$path" in /*) ;; *) fail 'Installation paths must be absolute' ;; esac
  case "$path" in *'
'*) fail 'Installation paths cannot contain newlines' ;; esac
done
case "$INSTALL_ROOT" in /|"$HOME"|"$HOME/.dy"|"$HOME/.dy/"*) fail 'Installation directory must be separate from the home and state directories' ;; esac
[ ! -L "$INSTALL_ROOT" ] || fail 'Installation directory cannot be a symbolic link'

canonical_directory() {
  path=$1
  case "$path" in /*) ;; *) path="$(pwd -P)/$path" ;; esac
  case "/$path/" in */../*|*/./*) fail 'Paths containing dot components are not supported' ;; esac
  tail=
  while [ ! -d "$path" ]; do
    [ ! -e "$path" ] && [ ! -L "$path" ] || fail 'A path component is not a directory'
    part=$(basename "$path")
    tail="/$part$tail"
    parent=$(dirname "$path")
    [ "$parent" != "$path" ] || fail 'Cannot resolve installation paths'
    path=$parent
  done
  physical=$(cd "$path" && pwd -P)
  printf '%s%s\n' "${physical%/}" "$tail"
}
state_root=$(canonical_directory "${DY_STATE_DIR:-$HOME/.dy}")
install_root=$(canonical_directory "$INSTALL_ROOT")
case "$install_root/" in "$state_root/"*) fail 'Installation and user state directories must not overlap' ;; esac
case "$state_root/" in "$install_root/"*) fail 'Installation and user state directories must not overlap' ;; esac
manage_skill=${DY_INSTALL_SKILL:-1}
for path in "$BIN_DIR"; do
  output_root=$(canonical_directory "$path")
  case "$output_root/" in "$state_root/"*) fail 'Command and skill directories must be separate from user state' ;; esac
done
if [ "$manage_skill" != 0 ]; then
  output_root=$(canonical_directory "$SKILLS_DIR")
  case "$output_root/" in "$state_root/"*) fail 'Command and skill directories must be separate from user state' ;; esac
fi

owned_launcher_at() {
  [ -f "$1" ] && [ ! -L "$1" ] &&
    grep -Fqx '# ShuaDouyin managed launcher v1' "$1" &&
    grep -Fqx "# install-root: $INSTALL_ROOT" "$1"
}
owned_launcher() { owned_launcher_at "$BIN_DIR/dy"; }
owned_release_target() {
  target=$1
  case "$target" in "$INSTALL_ROOT"/releases/*) ;; *) return 1 ;; esac
  name=${target#"$INSTALL_ROOT/releases/"}
  case "$name" in ''|.|..|*/*) return 1 ;; esac
  printf '%s\n' "$name" | grep -Eq '^[a-f0-9]{40}-[A-Za-z0-9]+$' || return 1
  release_path="$INSTALL_ROOT/releases/$name"
  [ -d "$release_path" ] && [ ! -L "$release_path" ] && [ -f "$release_path/.dy-release-owner" ] &&
    [ ! -L "$release_path/.dy-release-owner" ] && [ "$(cat "$release_path/.dy-release-owner")" = 'ShuaDouyin release v1' ]
}
owned_current() {
  [ -L "$INSTALL_ROOT/current" ] || return 1
  target=$(readlink "$INSTALL_ROOT/current") || return 1
  owned_release_target "$target"
}
owned_skill() {
  [ -L "$SKILLS_DIR/dy" ] || return 1
  [ "$(readlink "$SKILLS_DIR/dy")" = "$INSTALL_ROOT/current/app/skills/dy" ]
}
if [ -e "$BIN_DIR/dy" ] || [ -L "$BIN_DIR/dy" ]; then
  owned_launcher || fail "A different dy command exists at $BIN_DIR/dy; it was preserved"
fi

acquire_lock() {
  lock=$1
  if ! mkdir "$lock" 2>/dev/null; then fail "Another installer is active or a lock needs inspection: $lock"; fi
  if ! printf '%s\n' "$LOCK_TOKEN" > "$lock/owner"; then rmdir "$lock" 2>/dev/null || true; fail 'Could not create installer lock'; fi
}
mkdir -p "$(dirname "$INSTALL_ROOT")" "$BIN_DIR"
if [ "$manage_skill" != 0 ]; then mkdir -p "$SKILLS_DIR"; fi
root_lock_path="${install_root}.lock"
case "$root_lock_path/" in "$state_root/"*) fail 'Installer lock overlaps user state' ;; esac
case "$state_root/" in "$root_lock_path/"*) fail 'Installer lock overlaps user state' ;; esac
acquire_lock "$root_lock_path"
ROOT_LOCK=$root_lock_path
bin_lock_path="$(canonical_directory "$BIN_DIR")/.dy-installer.lock"
if [ "$bin_lock_path" != "$root_lock_path" ]; then
  acquire_lock "$bin_lock_path"
  BIN_LOCK=$bin_lock_path
fi
if [ "$manage_skill" != 0 ]; then
  skill_lock_path="$(canonical_directory "$SKILLS_DIR")/.dy-installer.lock"
  if [ "$skill_lock_path" != "$bin_lock_path" ] && [ "$skill_lock_path" != "$root_lock_path" ]; then
    acquire_lock "$skill_lock_path"
    SKILL_LOCK=$skill_lock_path
  fi
fi

if [ "$ACTION" = uninstall ]; then
  if [ -e "$INSTALL_ROOT/current" ] || [ -L "$INSTALL_ROOT/current" ]; then
    owned_current || fail 'Current version pointer is not owned by this installer; it was preserved'
  fi
  if [ -e "$BIN_DIR/dy" ] || [ -L "$BIN_DIR/dy" ]; then
    owned_launcher || fail 'The dy command is not owned by this installer; it was preserved'
    REMOVE_DIR=$(mktemp -d "$BIN_DIR/.dy-remove.XXXXXXXX")
    mv "$BIN_DIR/dy" "$REMOVE_DIR/entry"
    if ! owned_launcher_at "$REMOVE_DIR/entry"; then
      if [ -L "$REMOVE_DIR/entry" ] && ln -s "$(readlink "$REMOVE_DIR/entry")" "$BIN_DIR/dy" 2>/dev/null; then rm "$REMOVE_DIR/entry"
      elif [ -f "$REMOVE_DIR/entry" ] && [ ! -L "$REMOVE_DIR/entry" ] && ln "$REMOVE_DIR/entry" "$BIN_DIR/dy" 2>/dev/null; then rm "$REMOVE_DIR/entry"; fi
      fail "The dy command changed; the displaced item was preserved at $REMOVE_DIR/entry if it could not be restored"
    fi
    rm "$REMOVE_DIR/entry"
    rmdir "$REMOVE_DIR"
    REMOVE_DIR=
    notice 'Removed the managed dy command.'
  else
    notice 'Managed dy command is already absent.'
  fi
  retain_releases=0
  if [ "$manage_skill" != 0 ] && owned_skill; then
    REMOVE_DIR=$(mktemp -d "$SKILLS_DIR/.dy-remove.XXXXXXXX")
    mv "$SKILLS_DIR/dy" "$REMOVE_DIR/entry"
    if [ ! -L "$REMOVE_DIR/entry" ] || [ "$(readlink "$REMOVE_DIR/entry" 2>/dev/null || true)" != "$INSTALL_ROOT/current/app/skills/dy" ]; then
      if [ -L "$REMOVE_DIR/entry" ] && ln -s "$(readlink "$REMOVE_DIR/entry")" "$SKILLS_DIR/dy" 2>/dev/null; then rm "$REMOVE_DIR/entry"
      elif [ -f "$REMOVE_DIR/entry" ] && [ ! -L "$REMOVE_DIR/entry" ] && ln "$REMOVE_DIR/entry" "$SKILLS_DIR/dy" 2>/dev/null; then rm "$REMOVE_DIR/entry"; fi
      fail "The skill changed; the displaced item was preserved at $REMOVE_DIR/entry if it could not be restored"
    fi
    rm "$REMOVE_DIR/entry"
    rmdir "$REMOVE_DIR"
    REMOVE_DIR=
    notice 'Removed the managed agent skill.'
  elif [ "$manage_skill" != 0 ] && [ -L "$SKILLS_DIR/dy" ]; then
    retain_releases=1
  fi
  if [ "$manage_skill" = 0 ]; then
    notice 'Installation files were retained because skill management is disabled.'
  elif [ "$retain_releases" = 1 ]; then
    notice 'Installation files were retained because an unmanaged skill link exists.'
  elif [ -d "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ] && [ -f "$INSTALL_ROOT/.dy-installer-owner" ] &&
     [ ! -L "$INSTALL_ROOT/.dy-installer-owner" ] && [ "$(cat "$INSTALL_ROOT/.dy-installer-owner")" = 'ShuaDouyin installer v1' ]; then
    if [ ! -L "$INSTALL_ROOT/releases" ]; then
      if owned_current; then
        old_target=$(readlink "$INSTALL_ROOT/current")
        REMOVE_DIR=$(mktemp -d "$INSTALL_ROOT/.dy-remove.XXXXXXXX")
        mv "$INSTALL_ROOT/current" "$REMOVE_DIR/entry"
        if [ ! -L "$REMOVE_DIR/entry" ] || [ "$(readlink "$REMOVE_DIR/entry" 2>/dev/null || true)" != "$old_target" ]; then
          if [ -L "$REMOVE_DIR/entry" ] && ln -s "$(readlink "$REMOVE_DIR/entry")" "$INSTALL_ROOT/current" 2>/dev/null; then rm "$REMOVE_DIR/entry"
          elif [ -f "$REMOVE_DIR/entry" ] && [ ! -L "$REMOVE_DIR/entry" ] && ln "$REMOVE_DIR/entry" "$INSTALL_ROOT/current" 2>/dev/null; then rm "$REMOVE_DIR/entry"; fi
          fail "The current version changed; the displaced item was preserved at $REMOVE_DIR/entry if it could not be restored"
        fi
        rm "$REMOVE_DIR/entry"
        rmdir "$REMOVE_DIR"
        REMOVE_DIR=
      fi
      for release in "$INSTALL_ROOT"/releases/* "$INSTALL_ROOT"/releases/.stage.*; do
        [ -d "$release" ] && [ ! -L "$release" ] && [ -f "$release/.dy-release-owner" ] &&
          [ ! -L "$release/.dy-release-owner" ] && [ "$(cat "$release/.dy-release-owner")" = 'ShuaDouyin release v1' ] || continue
        REMOVE_DIR=$(mktemp -d "$INSTALL_ROOT/.dy-remove.XXXXXXXX")
        mv "$release" "$REMOVE_DIR/entry"
        if [ ! -d "$REMOVE_DIR/entry" ] || [ -L "$REMOVE_DIR/entry" ] ||
           [ ! -f "$REMOVE_DIR/entry/.dy-release-owner" ] || [ -L "$REMOVE_DIR/entry/.dy-release-owner" ] ||
           [ "$(cat "$REMOVE_DIR/entry/.dy-release-owner")" != 'ShuaDouyin release v1' ]; then
          fail "A release changed during uninstall; the displaced item was preserved at $REMOVE_DIR/entry"
        fi
        rm -rf "$REMOVE_DIR/entry"
        rmdir "$REMOVE_DIR"
        REMOVE_DIR=
      done
    else
      notice 'Unmanaged release-directory link was preserved.'
    fi
  fi
  notice "User state and browser sessions were not removed. Cached downloads remain in $INSTALL_ROOT/cache."
  exit 0
fi

case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'This installer supports macOS and Linux' ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'Unsupported CPU architecture' ;; esac
command -v tar >/dev/null 2>&1 || fail 'tar is required'
command -v curl >/dev/null 2>&1 || [ -n "$SOURCE_DIR" ] || fail 'curl is required'
if [ -e "$BIN_DIR/dy" ] || [ -L "$BIN_DIR/dy" ]; then
  owned_launcher || fail "A different dy command exists at $BIN_DIR/dy; it was preserved"
fi
existing_dy=$(command -v dy 2>/dev/null || true)
if [ -n "$existing_dy" ] && [ "$existing_dy" != "$BIN_DIR/dy" ]; then
  actual_bin=$(canonical_directory "$BIN_DIR")
  shadow=$(old_ifs=$IFS; IFS=:; for dir in $PATH; do
    actual_dir=$(cd "${dir:-.}" 2>/dev/null && pwd -P) || continue
    if [ "$actual_dir" = "$actual_bin" ]; then printf yes; break; fi
    if [ -x "${dir:-.}/dy" ]; then printf no; break; fi
  done; IFS=$old_ifs)
  if [ "$shadow" = yes ] && [ "${DY_INSTALL_ALLOW_SHADOW:-0}" != 1 ]; then
    fail "Installing $BIN_DIR/dy would shadow an existing dy command; choose another bin directory or set DY_INSTALL_ALLOW_SHADOW=1"
  fi
  notice "An existing dy command at $existing_dy will be preserved; check PATH after installation."
fi
if [ -e "$INSTALL_ROOT" ]; then
  [ -d "$INSTALL_ROOT" ] && [ -f "$INSTALL_ROOT/.dy-installer-owner" ] && [ ! -L "$INSTALL_ROOT/.dy-installer-owner" ] &&
    [ "$(cat "$INSTALL_ROOT/.dy-installer-owner")" = 'ShuaDouyin installer v1' ] ||
    fail 'Installation directory is not owned by this installer'
else
  mkdir -p "$INSTALL_ROOT"
  printf '%s\n' 'ShuaDouyin installer v1' > "$INSTALL_ROOT/.dy-installer-owner"
fi
[ ! -L "$INSTALL_ROOT/releases" ] || fail 'Release directory cannot be a symbolic link'
if [ ! -e "$INSTALL_ROOT/current" ] && [ ! -L "$INSTALL_ROOT/current" ]; then
  recover_path=
  for candidate in "$INSTALL_ROOT"/.switch.*/previous; do
    candidate_dir=$(dirname "$candidate")
    [ -d "$candidate_dir" ] && [ ! -L "$candidate_dir" ] && [ -f "$candidate_dir/.dy-switch-owner" ] &&
      [ ! -L "$candidate_dir/.dy-switch-owner" ] && [ "$(cat "$candidate_dir/.dy-switch-owner")" = 'ShuaDouyin switch v1' ] || continue
    [ -L "$candidate" ] || continue
    recover_target=$(readlink "$candidate") || continue
    owned_release_target "$recover_target" || continue
    [ -z "$recover_path" ] || fail 'Multiple interrupted version switches need inspection'
    recover_path=$candidate
  done
  if [ -n "$recover_path" ]; then
    recover_target=$(readlink "$recover_path")
    ln -s "$recover_target" "$INSTALL_ROOT/current" || fail 'Current version pointer appeared during recovery'
    rm "$recover_path"
    rm "$(dirname "$recover_path")/.dy-switch-owner"
    rmdir "$(dirname "$recover_path")" 2>/dev/null || true
    notice 'Restored the previous version from an interrupted switch.'
  fi
fi
if [ -e "$INSTALL_ROOT/current" ] || [ -L "$INSTALL_ROOT/current" ]; then
  owned_current || fail 'Current version pointer is not owned by this installer'
fi
[ ! -L "$INSTALL_ROOT/releases" ] || fail 'Release directory cannot be a symbolic link'
mkdir -p "$INSTALL_ROOT/releases" "$BIN_DIR"
STAGE=$(mktemp -d "$INSTALL_ROOT/releases/.stage.XXXXXXXX")
mkdir "$STAGE/app"

node_usable() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22 || (major===22 && minor>=19) ? 0 : 1)' >/dev/null 2>&1
}
NODE_BIN=$(command -v node 2>/dev/null || true)
LOCAL_NODE=false
if node_usable "$NODE_BIN"; then
  resolved_node=$("$NODE_BIN" -p 'process.execPath' 2>/dev/null || true)
  if node_usable "$resolved_node"; then NODE_BIN=$resolved_node; else NODE_BIN=; fi
fi
if ! node_usable "$NODE_BIN"; then
  command -v curl >/dev/null 2>&1 || fail 'curl is required to install Node.js'
  case "$platform" in linux)
    if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
      fail 'Install Node.js 22.19 or newer for this Linux environment, then run the installer again'
    fi ;;
  esac
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || fail 'A SHA-256 utility is required'
  name="node-v${NODE_VERSION}-${platform}-${arch}.tar.gz"
  url="https://nodejs.org/dist/v${NODE_VERSION}"
  notice 'Downloading the isolated Node.js runtime...'
  curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 "$url/$name" -o "$STAGE/$name"
  curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 30 "$url/SHASUMS256.txt" -o "$STAGE/SHASUMS256.txt"
  expected=$(awk -v name="$name" '$2 == name {print $1}' "$STAGE/SHASUMS256.txt")
  [ -n "$expected" ] || fail 'Node.js checksum not found'
  if command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$STAGE/$name" | awk '{print $1}'); else actual=$(sha256sum "$STAGE/$name" | awk '{print $1}'); fi
  [ "$actual" = "$expected" ] || fail 'Node.js checksum mismatch'
  mkdir "$STAGE/runtime"
  tar -xzf "$STAGE/$name" -C "$STAGE/runtime" --strip-components=1
  NODE_BIN="$STAGE/runtime/bin/node"
  node_usable "$NODE_BIN" || fail 'The downloaded Node.js runtime could not start'
  LOCAL_NODE=true
fi
NODE_DIR=$(dirname "$NODE_BIN")
PATH="$NODE_DIR:$PATH"; export PATH
export HUSKY=0
export npm_config_cache="$INSTALL_ROOT/cache/npm"
export COREPACK_HOME="$INSTALL_ROOT/cache/corepack"

if [ -n "$SOURCE_DIR" ]; then
  command -v git >/dev/null 2>&1 || fail 'git is required for --source'
  [ -d "$SOURCE_DIR" ] || fail 'Source directory does not exist'
  COMMIT=$(git -C "$SOURCE_DIR" rev-parse --verify HEAD)
  source_changes=$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=normal) || fail 'Cannot inspect local source status'
  if [ -n "$source_changes" ]; then
    notice 'Local source has uncommitted changes; the installer uses committed HEAD only.'
  fi
  git -C "$SOURCE_DIR" archive --format=tar --output="$STAGE/source.tar" HEAD
  tar -xf "$STAGE/source.tar" -C "$STAGE/app"
else
  notice 'Fetching the current project commit...'
  curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 30 "https://api.github.com/repos/$REPOSITORY/commits/main" -o "$STAGE/commit.json" || fail 'Cannot resolve the GitHub commit; check connectivity and API rate limits'
  COMMIT=$("$NODE_BIN" -e 'const fs=require("fs"), x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[a-f0-9]{40}$/.test(x.sha||""))process.exit(1);process.stdout.write(x.sha)' "$STAGE/commit.json") || fail 'Cannot determine the current project commit'
  curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 "https://codeload.github.com/$REPOSITORY/tar.gz/$COMMIT" -o "$STAGE/source.tar.gz" || fail 'Cannot download the project source archive'
  tar -xzf "$STAGE/source.tar.gz" -C "$STAGE/app" --strip-components=1
fi
case "$COMMIT" in *[!a-f0-9]*|'') fail 'Invalid source commit' ;; esac
[ "${#COMMIT}" -eq 40 ] || fail 'Invalid source commit'
[ -f "$STAGE/app/pnpm-lock.yaml" ] && [ -f "$STAGE/app/package.json" ] || fail 'Source archive is incomplete'

notice 'Installing locked dependencies and building dy...'
if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm --version 2>/dev/null || true)" = "$PNPM_VERSION" ]; then
  (cd "$STAGE/app" && pnpm install --frozen-lockfile --ignore-scripts --store-dir "$INSTALL_ROOT/cache/pnpm-store" && pnpm build)
elif [ -x "$NODE_DIR/corepack" ]; then
  (cd "$STAGE/app" && "$NODE_DIR/corepack" pnpm install --frozen-lockfile --ignore-scripts --store-dir "$INSTALL_ROOT/cache/pnpm-store" && "$NODE_DIR/corepack" pnpm build)
else
  command -v npm >/dev/null 2>&1 || fail 'npm is required to obtain the pinned pnpm version'
  (cd "$STAGE/app" && npm exec --yes --package="pnpm@$PNPM_VERSION" -- pnpm install --frozen-lockfile --ignore-scripts --store-dir "$INSTALL_ROOT/cache/pnpm-store" && npm exec --yes --package="pnpm@$PNPM_VERSION" -- pnpm build)
fi

notice 'Checking CLI, SQLite and agent guidance in an isolated workspace...'
"$NODE_BIN" "$STAGE/app/dist/cli.js" --version >/dev/null
"$NODE_BIN" "$STAGE/app/dist/cli.js" --state-dir "$STAGE/verify-state" init >/dev/null
"$NODE_BIN" "$STAGE/app/dist/cli.js" --state-dir "$STAGE/verify-state" memory add --text 'installation smoke test' --source 'user:installation-test' >/dev/null
"$NODE_BIN" "$STAGE/app/dist/cli.js" --state-dir "$STAGE/verify-state" memory status > "$STAGE/status.json"
"$NODE_BIN" -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!x.ok||!x.data.healthy)process.exit(1)' "$STAGE/status.json" || fail 'SQLite verification failed'
"$NODE_BIN" "$STAGE/app/dist/cli.js" --state-dir "$STAGE/verify-state" guide > "$STAGE/guide.json"
"$NODE_BIN" -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!x.ok||!x.data.markdown?.includes("growth"))process.exit(1)' "$STAGE/guide.json" || fail 'Agent guidance verification failed'
rm -rf "$STAGE/verify-state"
rm -f "$STAGE/source.tar" "$STAGE/source.tar.gz" "$STAGE/commit.json" "$STAGE/status.json" "$STAGE/guide.json" "$STAGE/SHASUMS256.txt" "$STAGE/node-v${NODE_VERSION}-${platform}-${arch}.tar.gz"
printf '%s\n' "$COMMIT" > "$STAGE/commit"
printf '%s\n' 'ShuaDouyin release v1' > "$STAGE/.dy-release-owner"

release="$INSTALL_ROOT/releases/${COMMIT}-$(basename "$STAGE" | sed 's/^\.stage\.//')"
mv "$STAGE" "$release"
STAGE=
if [ "$LOCAL_NODE" = true ]; then NODE_BIN="$release/runtime/bin/node"; fi
quote() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }
{
  printf '#!/bin/sh\n# ShuaDouyin managed release v1\n'
  printf 'exec %s %s "$@"\n' "$(quote "$NODE_BIN")" "$(quote "$release/app/dist/cli.js")"
} > "$release/run"
chmod 755 "$release/run"
LAUNCHER_TMP=$(mktemp "$BIN_DIR/.dy-launcher.XXXXXXXX")
{
  printf '#!/bin/sh\n# ShuaDouyin managed launcher v1\n# install-root: %s\n' "$INSTALL_ROOT"
  printf 'exec /bin/sh %s "$@"\n' "$(quote "$INSTALL_ROOT/current/run")"
} > "$LAUNCHER_TMP"
chmod 755 "$LAUNCHER_TMP"
if [ -e "$BIN_DIR/dy" ] || [ -L "$BIN_DIR/dy" ]; then
  owned_launcher || fail 'dy command changed during installation; it was preserved'
fi
if [ -e "$INSTALL_ROOT/current" ] || [ -L "$INSTALL_ROOT/current" ]; then
  owned_current || fail 'Current version pointer is not owned by this installer'
  old_target=$(readlink "$INSTALL_ROOT/current")
  SWITCH_OLD_TARGET=$old_target
  SWITCH_DIR=$(mktemp -d "$INSTALL_ROOT/.switch.XXXXXXXX")
  printf '%s\n' 'ShuaDouyin switch v1' > "$SWITCH_DIR/.dy-switch-owner"
  owned_current || fail 'Current version pointer changed during installation'
  mv "$INSTALL_ROOT/current" "$SWITCH_DIR/previous"
  if [ ! -L "$SWITCH_DIR/previous" ] || [ "$(readlink "$SWITCH_DIR/previous" 2>/dev/null || true)" != "$old_target" ]; then
    if [ -L "$SWITCH_DIR/previous" ] && ln -s "$(readlink "$SWITCH_DIR/previous")" "$INSTALL_ROOT/current" 2>/dev/null; then
      rm "$SWITCH_DIR/previous"
    elif [ -f "$SWITCH_DIR/previous" ] && [ ! -L "$SWITCH_DIR/previous" ] && ln "$SWITCH_DIR/previous" "$INSTALL_ROOT/current" 2>/dev/null; then
      rm "$SWITCH_DIR/previous"
    fi
    fail "Current version pointer changed; the displaced item was preserved at $SWITCH_DIR/previous if it could not be restored"
  fi
  if ! ln -s "$release" "$INSTALL_ROOT/current"; then
    if ln -s "$old_target" "$INSTALL_ROOT/current" 2>/dev/null; then rm "$SWITCH_DIR/previous"; fi
    fail "Current version pointer changed; the previous pointer was preserved at $SWITCH_DIR/previous if it could not be restored"
  fi
  if ! rm "$SWITCH_DIR/previous" || ! rm "$SWITCH_DIR/.dy-switch-owner" || ! rmdir "$SWITCH_DIR"; then
    notice "Updated the version; an old pointer remains at $SWITCH_DIR for inspection."
  fi
  SWITCH_DIR=
  SWITCH_OLD_TARGET=
else
  ln -s "$release" "$INSTALL_ROOT/current" || fail 'Current version pointer appeared during installation'
fi
if [ ! -e "$BIN_DIR/dy" ] && [ ! -L "$BIN_DIR/dy" ]; then
  ln "$LAUNCHER_TMP" "$BIN_DIR/dy" || fail 'A dy command appeared during installation; it was preserved'
else
  owned_launcher || fail 'dy command changed during installation; it was preserved'
fi
if ! rm "$LAUNCHER_TMP"; then notice "The command is installed; a temporary launcher remains at $LAUNCHER_TMP."; fi
LAUNCHER_TMP=

if [ "$manage_skill" != 0 ]; then
  if [ ! -e "$SKILLS_DIR/dy" ] && [ ! -L "$SKILLS_DIR/dy" ]; then
    if ! ln -s "$INSTALL_ROOT/current/app/skills/dy" "$SKILLS_DIR/dy"; then notice 'Could not install the agent skill; the CLI was installed.'; fi
  elif ! owned_skill; then
    notice "Existing agent skill at $SKILLS_DIR/dy was preserved."
  fi
fi
notice "Installed commit $COMMIT."
notice "Command: $BIN_DIR/dy"
selected=$(command -v dy 2>/dev/null || true)
[ "$selected" = "$BIN_DIR/dy" ] || notice "Add $BIN_DIR to PATH before other dy commands, or invoke the full path."
if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1 && [ ! -d '/Applications/Google Chrome.app' ]; then
  notice 'Install Google Chrome or Chromium before using browser operations.'
fi
notice 'Run dy init to set up your bot, then dy tui or dy guide.'
