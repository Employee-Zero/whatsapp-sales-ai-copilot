#!/bin/bash
#
# Builds the macOS installer for the ChatGPT OAuth helper.
#
# The output is one double-clickable .pkg that installs, on an Apple Silicon Mac:
#
#   /usr/local/lib/whatsapp-sales-ai-copilot/runtime/bin/node   a real Node.js
#   /usr/local/lib/whatsapp-sales-ai-copilot/helper/…           the helper source
#   /usr/local/lib/whatsapp-sales-ai-copilot/bin/run-helper.sh  how launchd starts it
#   /Library/LaunchAgents/com.employeezero….helper.plist        start at every login
#
# and then starts the helper in the session of the logged-in user. The person
# installing it needs no Node.js, no Homebrew and no terminal, and they are not
# asked to sign in to anything: the extension's own "Continue with ChatGPT"
# button is still what begins the OAuth flow, after the installer has closed.
#
# Nothing here is signed with a Developer ID, because there is no certificate in
# this repository to sign with. The package is reproducible and installs, but a
# downloaded copy will be refused by Gatekeeper on a machine that has never seen
# it before. See the note printed at the end of the build.
#
# Usage:
#   tools/helper-installer/build-macos-pkg.sh [--node-version vX.Y.Z] [--out-dir DIR]
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER_DIR="${REPO_ROOT}/tools/helper-installer"
CACHE_DIR="${REPO_ROOT}/tools/_local/helper-installer-cache"

PREFIX="/usr/local/lib/whatsapp-sales-ai-copilot"
LABEL="com.employeezero.whatsapp-sales-ai-copilot.helper"

# The Node LTS line. `engines` in helper/package.json asks for >=20; this is the
# concrete runtime that gets shipped, pinned so the same package can be rebuilt.
NODE_VERSION="v24.21.0"
OUT_DIR="${REPO_ROOT}/dist"

while [ $# -gt 0 ]; do
	case "$1" in
		--node-version) NODE_VERSION="$2"; shift 2 ;;
		--out-dir) OUT_DIR="$2"; shift 2 ;;
		-h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) echo "Unknown option: $1" >&2; exit 2 ;;
	esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. This package is arm64-only, by decision
# ---------------------------------------------------------------------------
# An Intel build would need a second runtime, a second payload and a way for the
# installer to choose between them. That is a real amount of machinery for a
# machine class this project does not otherwise target, so the build refuses to
# pretend: it produces one architecture and says so in the filename.
[ "$(uname -s)" = "Darwin" ] || die "This builds a macOS package, and this is not macOS."
[ "$(uname -m)" = "arm64" ] || die "This builds an Apple Silicon (arm64) package; this machine is $(uname -m)."

ARCH="arm64"
TARBALL="node-${NODE_VERSION}-darwin-${ARCH}.tar.gz"
NODE_DIST="https://nodejs.org/dist/${NODE_VERSION}"

HELPER_VERSION="$(/usr/bin/plutil -extract version raw -o - "${REPO_ROOT}/helper/package.json" 2>/dev/null)"
[ -n "$HELPER_VERSION" ] || die "Could not read the helper version from helper/package.json."

PKG_NAME="whatsapp-sales-ai-copilot-helper-${HELPER_VERSION}-macos-${ARCH}.pkg"

say "Building ${PKG_NAME} (helper ${HELPER_VERSION}, Node ${NODE_VERSION} ${ARCH})"

# ---------------------------------------------------------------------------
# 1. Fetch the runtime, and prove it is the runtime we asked for
# ---------------------------------------------------------------------------
# The bundled Node is the only binary in this package, so where it comes from is
# the whole supply chain. It comes from nodejs.org over TLS, and the bytes are
# checked against the SHA-256 that nodejs.org publishes next to them. That check
# is the point of downloading the checksum file separately rather than trusting
# the archive: an archive that was tampered with in transit will not match.
mkdir -p "$CACHE_DIR"

if [ ! -f "${CACHE_DIR}/${TARBALL}" ] || [ ! -f "${CACHE_DIR}/SHASUMS256.txt" ]; then
	say "Downloading ${TARBALL} from nodejs.org"
	/usr/bin/curl -fsSL --proto '=https' --tlsv1.2 -o "${CACHE_DIR}/${TARBALL}.part" "${NODE_DIST}/${TARBALL}"
	/usr/bin/curl -fsSL --proto '=https' --tlsv1.2 -o "${CACHE_DIR}/SHASUMS256.txt.part" "${NODE_DIST}/SHASUMS256.txt"
	mv "${CACHE_DIR}/${TARBALL}.part" "${CACHE_DIR}/${TARBALL}"
	mv "${CACHE_DIR}/SHASUMS256.txt.part" "${CACHE_DIR}/SHASUMS256.txt"
fi

EXPECTED="$(/usr/bin/awk -v f="${TARBALL}" '$2 == f { print $1 }' "${CACHE_DIR}/SHASUMS256.txt")"
[ -n "$EXPECTED" ] || die "${TARBALL} is not listed in SHASUMS256.txt."
ACTUAL="$(/usr/bin/shasum -a 256 "${CACHE_DIR}/${TARBALL}" | /usr/bin/awk '{ print $1 }')"
[ "$EXPECTED" = "$ACTUAL" ] || die "Checksum mismatch for ${TARBALL}:
  expected ${EXPECTED}
  actual   ${ACTUAL}
Refusing to package a runtime that is not the one nodejs.org published."
say "Runtime checksum matches nodejs.org's SHASUMS256.txt"

# ---------------------------------------------------------------------------
# 2. Stage the payload
# ---------------------------------------------------------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/siwc-pkg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

PAYLOAD="${STAGE}/payload"
LIBDIR="${PAYLOAD}${PREFIX}"
mkdir -p "${LIBDIR}/runtime/bin" "${LIBDIR}/helper/lib" "${LIBDIR}/bin" "${PAYLOAD}/Library/LaunchAgents"

# Only bin/node is taken from the tarball. npm, Corepack, the headers and the
# bundled npm's ~30k files are all dead weight in a package whose job is to run
# one script that imports nothing but node: builtins.
/usr/bin/tar -xzf "${CACHE_DIR}/${TARBALL}" -C "$STAGE" "node-${NODE_VERSION}-darwin-${ARCH}/bin/node"
cp "${STAGE}/node-${NODE_VERSION}-darwin-${ARCH}/bin/node" "${LIBDIR}/runtime/bin/node"
chmod 755 "${LIBDIR}/runtime/bin/node"

cp "${REPO_ROOT}/helper/siwc-helper.js" "${LIBDIR}/helper/"
cp "${REPO_ROOT}"/helper/lib/*.js "${LIBDIR}/helper/lib/"
chmod 644 "${LIBDIR}"/helper/*.js "${LIBDIR}"/helper/lib/*.js

# The two files that carry a placeholder get it filled in here, so the prefix
# lives in exactly one place in the source tree.
/usr/bin/sed "s|__PREFIX__|${PREFIX}|g" \
	"${INSTALLER_DIR}/macos/payload/bin/run-helper.sh.in" > "${LIBDIR}/bin/run-helper.sh"
chmod 755 "${LIBDIR}/bin/run-helper.sh"

/usr/bin/sed "s|__PREFIX__|${PREFIX}|g" \
	"${INSTALLER_DIR}/macos/LaunchAgent.plist.in" > "${PAYLOAD}/Library/LaunchAgents/${LABEL}.plist"
chmod 644 "${PAYLOAD}/Library/LaunchAgents/${LABEL}.plist"

# A placeholder that survived substitution means the plist would point launchd at
# a path called __PREFIX__/…, and the job would fail at every login with nothing
# on screen to say why. Cheaper to catch it here.
if /usr/bin/grep -rl '__PREFIX__' "$PAYLOAD" >/dev/null 2>&1; then
	die "A __PREFIX__ placeholder survived substitution."
fi

# ---------------------------------------------------------------------------
# 3. Check the runtime really is standalone and really is for this CPU
# ---------------------------------------------------------------------------
# The requirement this guards is "the person installing this must not need
# Homebrew". An official Node tarball links against system libraries only; a
# binary that had been built or copied from a Homebrew tree would carry an
# /opt/homebrew path in its load commands and would refuse to start on a Mac
# that does not have it — after a successful install, with no error a user could
# act on.
LINKED="$(/usr/bin/otool -L "${LIBDIR}/runtime/bin/node")"
if /usr/bin/grep -Eq '/(opt/homebrew|usr/local/(opt|Cellar))/' <<<"$LINKED"; then
	die "The runtime links against a package-manager path, so it is not standalone:
${LINKED}"
fi

ARCHS="$(/usr/bin/lipo -archs "${LIBDIR}/runtime/bin/node")"
[ "$ARCHS" = "arm64" ] || die "The runtime is ${ARCHS}, not arm64."

SIGNATURE="$(/usr/bin/codesign --verify --strict --verbose=4 "${LIBDIR}/runtime/bin/node" 2>&1 || true)"
if /usr/bin/grep -q 'valid on disk' <<<"$SIGNATURE"; then
	DETAIL="$(/usr/bin/codesign -dv --verbose=2 "${LIBDIR}/runtime/bin/node" 2>&1 || true)"
	# awk without `exit`: stopping early would send SIGPIPE back down the pipe,
	# and `set -o pipefail` would turn that into a failed command.
	NODE_SIGNER="$(printf '%s\n' "$DETAIL" | /usr/bin/awk -F= '/^Authority/ { if (!seen) { print $2; seen = 1 } }')"
	say "Bundled runtime signature verifies (${NODE_SIGNER:-unknown authority})"
else
	# Not fatal — the tarball's signature is not ours to keep — but a runtime
	# whose signature does not verify is a runtime macOS may refuse to launch
	# from a quarantined package, so it is worth saying out loud.
	say "Warning: the bundled runtime's code signature does not verify."
fi

say "Runtime verified: standalone arm64, no package-manager dependencies"

# ---------------------------------------------------------------------------
# 4. Build the package
# ---------------------------------------------------------------------------
mkdir -p "$OUT_DIR"
PKG_PATH="${OUT_DIR}/${PKG_NAME}"
rm -f "$PKG_PATH"

# A component package, installed at /. Double-clicking one of these opens
# Installer.app the same way a product archive does; the product archive would
# only add a welcome screen and a title, which is not worth a second build step
# and a second build tool.
# Installer.app runs ./postinstall directly, so the file must be executable and
# must start with a shebang. A checkout that lost the mode bit (or a copy that
# added a com.apple.provenance xattr, which pkgbuild archives as ._postinstall)
# produced a package that failed with "postinstall does not exist" (PKInstallError
# 112). So the scripts are staged into a clean directory and fixed here, instead
# of trusting whatever mode the source tree happens to have.
SCRIPTS="${STAGE}/scripts"
mkdir -p "$SCRIPTS"
cp "${INSTALLER_DIR}/macos/scripts/postinstall" "${SCRIPTS}/postinstall"
chmod 755 "${SCRIPTS}/postinstall"
/usr/bin/xattr -cr "$SCRIPTS" "$PAYLOAD" 2>/dev/null || true
[ -x "${SCRIPTS}/postinstall" ] || die "postinstall is not executable."
[ "$(head -c 2 "${SCRIPTS}/postinstall")" = "#!" ] || die "postinstall has no shebang."
if /usr/bin/grep -q $'\r' "${SCRIPTS}/postinstall"; then die "postinstall has CRLF line endings."; fi

COPYFILE_DISABLE=1 /usr/bin/pkgbuild \
	--root "$PAYLOAD" \
	--scripts "$SCRIPTS" \
	--identifier "$LABEL" \
	--version "$HELPER_VERSION" \
	--install-location / \
	--ownership recommended \
	"$PKG_PATH" >/dev/null

say "Built ${PKG_PATH}"
/usr/bin/stat -f '    size: %z bytes' "$PKG_PATH"
printf '    sha256: %s\n' "$(/usr/bin/shasum -a 256 "$PKG_PATH" | /usr/bin/awk '{ print $1 }')"

SIG_STATUS="$(/usr/sbin/pkgutil --check-signature "$PKG_PATH" 2>/dev/null || true)"
if /usr/bin/grep -q 'Status: signed' <<<"$SIG_STATUS"; then
	say "Package is signed."
else
	cat <<'EOF'

    This package is NOT signed with a Developer ID and NOT notarized by Apple.
    It installs correctly, but on any Mac that did not build it, Gatekeeper will
    refuse the first double-click — the package was assembled from a source
    build, not from a certificate this repository does not have. The person
    installing it can allow it once from System Settings › Privacy & Security
    ("Open Anyway"). Do not describe this artifact as signed or notarized, and
    do not tell anyone to disable Gatekeeper to get past it.
EOF
fi
