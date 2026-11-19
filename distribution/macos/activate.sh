#!/bin/sh
set -eu

if [ "$(/usr/bin/uname -s)" != Darwin ] || [ "$(/usr/bin/uname -m)" != arm64 ]; then
  printf '%s\n' 'Mosaic Beta requires an Apple Silicon Mac.' >&2
  exit 1
fi
if [ "$(/usr/bin/id -u)" -eq 0 ]; then
  printf '%s\n' 'Open this file in Finder from your own account, without sudo.' >&2
  exit 1
fi
if [ -z "${HOME:-}" ]; then
  printf '%s\n' 'Open this file in Finder from your own account.' >&2
  exit 1
fi

stem='@ARCHIVE_STEM@'
expected='@ARCHIVE_SHA256@'
here=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
archive="$here/$stem.tar.gz"
if [ ! -f "$archive" ] || [ -L "$archive" ]; then
  printf '%s\n' 'The Mosaic archive is missing. Open the original .pkg to restore it.' >&2
  exit 1
fi

launcher="$HOME/.local/bin/mosaic"
settings="$HOME/Library/Application Support/Mosaic Beta/config/settings.json"
first_install=yes
if [ -e "$launcher" ] || [ -L "$launcher" ] || [ -e "$settings" ]; then
  first_install=no
fi

umask 077
temp=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/mosaic-setup.XXXXXXXX")
temp=$(CDPATH= cd -P -- "$temp" && pwd -P)
activation_running=no
cleanup() {
  if [ "$activation_running" = no ]; then
    /bin/rm -rf -- "$temp"
  else
    printf 'Mosaic activation was interrupted. Temporary files are at %s\n' "$temp" >&2
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

(
  CDPATH= cd -- "$temp"
  /bin/cp -- "$archive" archive.tar.gz
  if ! printf '%s  %s\n' "$expected" archive.tar.gz | /usr/bin/shasum -a 256 -c --status; then
    printf '%s\n' 'The Mosaic archive checksum does not match. Open the original .pkg to restore it.' >&2
    exit 1
  fi
  /usr/bin/tar -xzpf archive.tar.gz --no-same-owner --no-mac-metadata --no-acls --no-fflags --no-xattrs -- "$stem"
)
activation_running=yes
if "$temp/$stem/install" --no-path; then
  activation_running=no
else
  activation_running=no
  exit 1
fi
cleanup
trap - EXIT HUP INT TERM

if [ "$first_install" = yes ] && [ -t 0 ] && [ -t 1 ]; then
  printf 'Open Mosaic setup now? [y/N] '
  answer=''
  if IFS= read -r answer; then
    case "$answer" in
      [Yy]|[Yy][Ee][Ss]) exec "$launcher" setup ;;
    esac
  fi
fi
