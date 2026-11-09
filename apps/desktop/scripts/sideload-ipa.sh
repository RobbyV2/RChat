#!/usr/bin/env bash
# Makes the unsigned iOS build installable with sideloading tools (AltStore, SideStore, Sideloadly,
# TrollStore, LiveContainer): signs the app ad hoc, which needs no key, and zips it again.
# Usage: apps/desktop/scripts/sideload-ipa.sh <in.ipa> <out.ipa>
# Needs python3 and codesign (macOS).
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: sideload-ipa.sh <in.ipa> <out.ipa>" >&2
  exit 2
fi
in=$1
out=$2
min_ios=16.4
scheme=rchat

# `python3 -m zipfile` drops file modes and symbolic links, so the zip steps are written out.
ipa() {
  python3 -I - "$@" <<'PY'
import os, plistlib, stat, sys, zipfile


# Links are made after every file is out, so no file is written through one, and each link must
# end up inside its own app, so nothing outside is read or signed later.
def unpack(source, folder):
    links = []
    with zipfile.ZipFile(source) as archive:
        for entry in archive.infolist():
            mode = entry.external_attr >> 16
            path = archive.extract(entry, folder)
            if stat.S_ISLNK(mode):
                links.append((path, archive.read(entry).decode()))
            elif not entry.is_dir() and stat.S_IMODE(mode):
                os.chmod(path, stat.S_IMODE(mode))
    for path, target in links:
        os.remove(path)
        os.symlink(target, path)
    for path, _ in links:
        name = os.path.relpath(path, folder)
        app = os.path.realpath(os.path.join(folder, *name.split(os.sep)[:2]))
        if not os.path.realpath(path).startswith(app + os.sep):
            sys.exit(f'The link {name} points outside its app.')


def check(path, minimum, scheme):
    with open(path, 'rb') as file:
        info = plistlib.load(file)
    found = info.get('MinimumOSVersion')
    if found != minimum:
        sys.exit(f'MinimumOSVersion is {found}, expected {minimum}.')
    kinds = info.get('CFBundleURLTypes', [])
    if not any(scheme in kind.get('CFBundleURLSchemes', []) for kind in kinds):
        sys.exit(f'CFBundleURLTypes has no {scheme} scheme, so {scheme}:// links would not open the app.')
    print(f"Version {info['CFBundleShortVersionString']} ({info['CFBundleVersion']}), iOS {found} or newer")


def pack(folder, target):
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for parent, folders, files in os.walk(os.path.join(folder, 'Payload')):
            folders.sort()
            archive.write(parent, os.path.relpath(parent, folder))
            for name in sorted(folders + files):
                path = os.path.join(parent, name)
                if os.path.islink(path):
                    entry = zipfile.ZipInfo(os.path.relpath(path, folder))
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                    archive.writestr(entry, os.readlink(path))
                elif name in files:
                    archive.write(path, os.path.relpath(path, folder))


try:
    {'unpack': unpack, 'check': check, 'pack': pack}[sys.argv[1]](*sys.argv[2:])
except (OSError, KeyError, ValueError, zipfile.BadZipFile) as error:
    sys.exit(f'Not a usable IPA: {type(error).__name__}: {error}')
PY
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

ipa unpack "$in" "$work"
shopt -s nullglob
apps=("$work"/Payload/*.app)
if [ ${#apps[@]} -ne 1 ]; then
  echo "Expected one app in Payload, found ${#apps[@]}." >&2
  exit 1
fi
app=${apps[0]}
ipa check "$app/Info.plist" "$min_ios" "$scheme"

sign() {
  codesign --force --sign - --timestamp=none "$1"
}
# Nested code first: the app's signature seals what is inside it.
for nested in "$app"/Frameworks/* "$app"/PlugIns/*.appex; do sign "$nested"; done
sign "$app"

ipa pack "$work" "$work/sideload.ipa"
mv "$work/sideload.ipa" "$out"
