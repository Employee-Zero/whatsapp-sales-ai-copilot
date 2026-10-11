#!/bin/bash
#
# Checks the helper installer package without installing it.
#
# Everything here runs as the current user, in temporary directories, and is
# undone on the way out. It never touches /usr/local, /Library/LaunchAgents, a
# real LaunchAgent, a real Chrome profile or a real ChatGPT account, and it does
# not open a browser or start a sign-in.
#
# What it does check, in order:
#
#   1. the package's structure — the payload contains what it claims to and the
#      LaunchAgent plist is a valid plist that names an absolute path;
#   2. the bundled Node really runs, standalone, and the helper answers /health
#      on 127.0.0.1 and on nothing else;
#   3. the credential file it creates is owner-only;
#   4. optionally, that launchd can start the job from the packaged plist — the
#      part that a unit test of the JavaScript cannot reach.
#
# What it cannot check, and does not pretend to: the Installer.app window, the
# Gatekeeper decision on a machine that has never seen the package, whether the
# job comes back after a real reboot, and the real OAuth flow. Those need a
# person and a browser.
#
# Usage:
#   tools/helper-installer/test-macos-pkg.sh [path/to/pkg] [--launchctl]
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_PATH="${1:-}"
WITH_LAUNCHCTL=0
for arg in "$@"; do
	[ "$arg" = "--launchctl" ] && WITH_LAUNCHCTL=1
done
case "$PKG_PATH" in --*) PKG_PATH="";; esac

if [ -z "$PKG_PATH" ]; then
	PKG_PATH="$(/bin/ls -t "${REPO_ROOT}"/dist/ChatGPT-Connector-for-Sales-AI-Copilot-macOS-arm64.pkg 2>/dev/null | /usr/bin/head -1 || true)"
fi
[ -n "$PKG_PATH" ] && [ -f "$PKG_PATH" ] || { echo "No package found. Build one first, or pass a path." >&2; exit 1; }

LABEL="com.employeezero.whatsapp-sales-ai-copilot.helper"
TEST_LABEL="${LABEL}.selftest"
PREFIX_REL="usr/local/lib/whatsapp-sales-ai-copilot"

PASS=0
FAIL=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/siwc-test.XXXXXX")"
# Resolved through any symlink, because on macOS $TMPDIR is under /var, which is
# a link to /private/var — and ES module loading resolves symlinks. Running the
# helper from an unresolved path makes Node compare two different spellings of
# the same file, decide it was imported rather than run, and exit silently.
WORK="$(cd "$WORK" && pwd -P)"
RUNNING_PID=""
cleanup() {
	[ -n "$RUNNING_PID" ] && kill "$RUNNING_PID" 2>/dev/null || true
	if [ "$WITH_LAUNCHCTL" = "1" ]; then
		/bin/launchctl bootout "gui/$(id -u)/${TEST_LABEL}" 2>/dev/null || true
	fi
	rm -rf "$WORK"
}
trap cleanup EXIT

echo "Package: $PKG_PATH"
echo "         $(/usr/bin/stat -f '%z bytes' "$PKG_PATH")  sha256 $(/usr/bin/shasum -a 256 "$PKG_PATH" | /usr/bin/awk '{ print $1 }')"

# ---------------------------------------------------------------------------
head_ "1. Package structure"
# ---------------------------------------------------------------------------
/usr/sbin/pkgutil --expand-full "$PKG_PATH" "$WORK/expanded" >/dev/null 2>&1 || bad "pkgutil --expand-full failed"
[ -d "$WORK/expanded" ] && ok "package expands (valid flat package)"

# PackageInfo is pkgutil's own XML dialect, not a plist plutil will parse, so the
# two attributes are read out of it directly. The leading space in the version
# pattern is what keeps `format-version` and `generator-version` out of the match.
IDENT="$(/usr/bin/sed -n 's/.* identifier="\([^"]*\)".*/\1/p' "$WORK/expanded/PackageInfo" 2>/dev/null)"
[ "$IDENT" = "$LABEL" ] && ok "identifier is $LABEL" || bad "identifier is '$IDENT', expected '$LABEL'"
VERSION="$(/usr/bin/sed -n '/<pkg-info/ s/.* version="\([^"]*\)".*/\1/p' "$WORK/expanded/PackageInfo" 2>/dev/null)"
PKG_VERSION="$(/usr/bin/plutil -extract version raw -o - "${REPO_ROOT}/helper/package.json" 2>/dev/null)"
[ "$VERSION" = "$PKG_VERSION" ] && ok "package version is $VERSION" || bad "package version is '$VERSION', helper/package.json says '$PKG_VERSION'"

PAYLOAD="$WORK/expanded/Payload"
for rel in \
	"${PREFIX_REL}/runtime/bin/node" \
	"${PREFIX_REL}/helper/siwc-helper.js" \
	"${PREFIX_REL}/helper/lib/oauth.js" \
	"${PREFIX_REL}/helper/lib/store.js" \
	"${PREFIX_REL}/ChatGPT Connector for Sales AI Copilot.app/Contents/MacOS/ChatGPT Connector" \
	"${PREFIX_REL}/ChatGPT Connector for Sales AI Copilot.app/Contents/Info.plist" \
	"Library/LaunchAgents/${LABEL}.plist"
do
	[ -e "$PAYLOAD/$rel" ] && ok "payload has $rel" || bad "payload is missing $rel"
done

# The uninstaller relies on this path in its --sign-out step; if the shebang line
# or the layout ever changes, the failure would only show up at uninstall time.
WRAP="$PAYLOAD/${PREFIX_REL}/ChatGPT Connector for Sales AI Copilot.app/Contents/MacOS/ChatGPT Connector"
[ -x "$WRAP" ] && ok "app bundle executable is executable" || bad "app bundle executable is not executable"
[ "$(/usr/bin/plutil -extract CFBundleName raw -o - "$PAYLOAD/${PREFIX_REL}/ChatGPT Connector for Sales AI Copilot.app/Contents/Info.plist" 2>/dev/null)" = "ChatGPT Connector for Sales AI Copilot" ] && ok "bundle name is ChatGPT Connector for Sales AI Copilot" || bad "bundle name is wrong"
/usr/bin/grep -q 'bin/node' "$WRAP" && ok "wrapper invokes the bundled runtime" || bad "wrapper does not invoke the bundled runtime"

PLIST="$PAYLOAD/Library/LaunchAgents/${LABEL}.plist"
/usr/bin/plutil -lint "$PLIST" >/dev/null 2>&1 && ok "LaunchAgent plist is a valid plist" || bad "LaunchAgent plist does not lint"
/usr/bin/grep -q '__PREFIX__' "$PLIST" && bad "plist still contains __PREFIX__" || ok "plist has no unsubstituted placeholders"

PROGRAM="$(/usr/bin/plutil -extract ProgramArguments.0 raw -o - "$PLIST" 2>/dev/null || true)"
[ -x "$PAYLOAD$PROGRAM" ] && ok "launchd would start $PROGRAM (exists, executable)" || bad "ProgramArguments points at '$PROGRAM', which is not an executable in the payload"

[ "$(/usr/bin/plutil -extract RunAtLoad raw -o - "$PLIST" 2>/dev/null)" = "true" ] \
	&& ok "RunAtLoad is set — it starts again at the next login" \
	|| bad "RunAtLoad is not set: the helper would not come back at login"

# A job that runs as root would put the credential in root's home and leave the
# extension unable to reach it. The plist must not ask for that.
/usr/bin/grep -q '<key>UserName</key>' "$PLIST" && bad "plist sets UserName: the helper would not run as the logged-in user" || ok "no UserName: the job runs as whoever is logged in"

/usr/bin/grep -q '<key>StandardOutPath</key>' "$PLIST" \
	&& bad "plist sets StandardOutPath: one shared path cannot be right for every user" \
	|| ok "logging is left to run-helper.sh, which knows who is logged in"

# The installer must not begin a sign-in. The user does that from the extension
# afterwards, in their own browser, on their own account.
POST="$WORK/expanded/Scripts/postinstall"
if [ -f "$POST" ]; then
	ok "postinstall script is present"
	# Installer.app execs ./postinstall itself. A missing +x or shebang fails the
	# whole install with PKInstallErrorDomain 112 "postinstall does not exist".
	[ -x "$POST" ] && ok "postinstall is executable (+x)" || bad "postinstall is NOT executable — Installer.app would fail with error 112"
	[ "$(/usr/bin/head -c 2 "$POST")" = "#!" ] && ok "postinstall starts with a shebang" || bad "postinstall has no shebang"
	/usr/bin/grep -q $'\r' "$POST" && bad "postinstall has CRLF line endings" || ok "postinstall has LF line endings"
	/bin/sh -n "$POST" && ok "postinstall passes sh -n syntax check" || bad "postinstall has a syntax error"
	# The check that matters is the mode inside the real Scripts archive — what
	# Installer.app extracts and execs — not the unpacked copy. (A harmless
	# ._postinstall AppleDouble can appear beside it on macOS 15+: the
	# com.apple.provenance xattr cannot be stripped by a build script.)
	mkdir -p "$WORK/xar" && ( cd "$WORK/xar" && /usr/bin/xar -xf "$PKG_PATH" Scripts 2>/dev/null )
	if /usr/bin/gzip -dc "$WORK/xar/Scripts" 2>/dev/null | /usr/bin/cpio -tv 2>/dev/null | /usr/bin/grep -Eq '^-rwxr-xr-x.* \./postinstall$'; then
		ok "archived ./postinstall is mode 755"
	else
		bad "archived ./postinstall is not mode 755 inside the package"
	fi
	if /usr/bin/grep -Eq -- '--print-authorize-url|/auth/start|auth\.openai\.com|/usr/bin/open|open -a' "$POST"; then
		bad "postinstall appears to start a sign-in or open a browser"
	else
		ok "postinstall starts no sign-in and opens no browser"
	fi
	/usr/bin/grep -q 'launchctl bootstrap' "$POST" && ok "postinstall starts the job in the console session" || bad "postinstall does not start the job"
	/usr/bin/grep -q 'xattr' "$POST" && bad "postinstall strips quarantine attributes" || ok "postinstall does not touch Gatekeeper state"
else
	bad "no postinstall script in the package"
fi

# ---------------------------------------------------------------------------
head_ "2. The bundled runtime runs, standalone"
# ---------------------------------------------------------------------------
SANDBOX="$WORK/sandbox"
mkdir -p "$SANDBOX"
cp -R "$PAYLOAD/${PREFIX_REL}/." "$SANDBOX/"
export HOME="$WORK/home"
export WHATSAPP_COPILOT_HOME="$WORK/config"
mkdir -p "$HOME" "$WHATSAPP_COPILOT_HOME"
chmod 700 "$WHATSAPP_COPILOT_HOME"

"$SANDBOX/runtime/bin/node" --version >/dev/null 2>&1 \
	&& ok "bundled node runs: $("$SANDBOX/runtime/bin/node" --version)" \
	|| bad "bundled node does not run"

NODE_MAJOR="$("$SANDBOX/runtime/bin/node" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] && ok "runtime satisfies the helper's >=20 requirement" || bad "runtime is Node $NODE_MAJOR, below 20"

# A port that is actually free, so the check cannot collide with a real helper.
PORT=""
for candidate in 28788 38788 47881 53001 61112; do
	if ! /usr/sbin/lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then PORT="$candidate"; break; fi
done
[ -n "$PORT" ] || { bad "no free port for the isolated run"; PORT=47881; }

"$SANDBOX/runtime/bin/node" "$SANDBOX/helper/siwc-helper.js" --port "$PORT" >"$WORK/helper.log" 2>&1 &
RUNNING_PID=$!

HEALTH=""
for _ in $(seq 1 40); do
	if HEALTH="$(/usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null)"; then break; fi
	HEALTH=""
	kill -0 "$RUNNING_PID" 2>/dev/null || break
	/bin/sleep 0.25
done

if [ -n "$HEALTH" ]; then
	ok "GET /health on 127.0.0.1:${PORT} answers"
	if /usr/bin/grep -q '"ok":true' <<<"$HEALTH"; then ok "health payload says ok:true"; else bad "health payload: $HEALTH"; fi
	# Nothing sensitive may appear in a response the extension can read.
	if /usr/bin/grep -Eqi 'access_token|refresh_token|"token"' <<<"$HEALTH"; then
		bad "/health leaks a token"
	else
		ok "/health reports no token material"
	fi
else
	bad "helper did not answer /health; log follows"
	/usr/bin/sed 's/^/       /' "$WORK/helper.log" | /usr/bin/tail -5
fi

# Bound to loopback, and only loopback. This is the whole security model of the
# helper: a listener on 0.0.0.0 would hand the credential to the local network.
if [ -n "$RUNNING_PID" ]; then
	# -a is what makes lsof AND the filters instead of ORing them; without it,
	# "-p <pid> -iTCP" lists every listening socket on the machine.
	LISTEN="$(/usr/sbin/lsof -nP -a -p "$RUNNING_PID" -iTCP -sTCP:LISTEN 2>/dev/null || true)"
	if [ -n "$LISTEN" ] && ! /usr/bin/grep -Eq '(\*|0\.0\.0\.0|\[::\]):' <<<"$LISTEN"; then
		ok "listening on 127.0.0.1 only"
	else
		bad "listener is not loopback-only:
$LISTEN"
	fi

	# A request with someone else's Host header must be refused; a page in a
	# browser can reach 127.0.0.1, and this is what stops it.
	CODE="$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H 'Host: evil.example.com' "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo 000)"
	[ "$CODE" = "403" ] && ok "a request with a foreign Host header is refused (403)" || bad "foreign Host header returned $CODE, expected 403"

	/usr/bin/curl -fsS --max-time 3 -X POST "http://127.0.0.1:${PORT}/auth/sign-out" >/dev/null 2>&1 || true
	kill "$RUNNING_PID" 2>/dev/null || true
	wait "$RUNNING_PID" 2>/dev/null || true
	RUNNING_PID=""
fi

# ---------------------------------------------------------------------------
head_ "3. The credential store is owner-only, and empty after installing"
# ---------------------------------------------------------------------------
# Two separate claims. The first is about the installer: starting the helper must
# not create a credential, because installing is not signing in. The second is
# about the code that ships: when the packaged store module does write, it writes
# 0700/0600. The second is checked by calling that module directly, in a
# throwaway home, with a store that holds no token — no sign-in, no network.
STORE_FILE="$WHATSAPP_COPILOT_HOME/credentials.json"
if [ -f "$STORE_FILE" ]; then
	bad "the helper created a credential file without anyone signing in"
else
	ok "no credential was created just by installing and starting it"
fi

PROBE="$WORK/credprobe"
mkdir -p "$PROBE"
if HOME="$WORK/home" WHATSAPP_COPILOT_HOME="$PROBE" "$SANDBOX/runtime/bin/node" --input-type=module \
	-e "const m = await import('file://${SANDBOX}/helper/lib/store.js'); m.writeStore({ version: 1, hostId: 'selftest', activeAccount: '', accounts: {} });" \
	>/dev/null 2>&1
then
	DIR_MODE="$(/usr/bin/stat -f '%Lp' "$PROBE")"
	FILE_MODE="$(/usr/bin/stat -f '%Lp' "$PROBE/credentials.json" 2>/dev/null || echo missing)"
	[ "$DIR_MODE" = "700" ] && ok "the packaged store creates its directory mode 700" || bad "store directory is mode $DIR_MODE, expected 700"
	[ "$FILE_MODE" = "600" ] && ok "the packaged store creates credentials.json mode 600" || bad "credentials.json is mode $FILE_MODE, expected 600"
else
	bad "the packaged store module could not be loaded"
fi
rm -rf "$PROBE"

# ---------------------------------------------------------------------------
head_ "4. launchd can start the packaged job (isolated, current user)"
# ---------------------------------------------------------------------------
if [ "$WITH_LAUNCHCTL" != "1" ]; then
	echo "  skipped — pass --launchctl to include it"
elif /usr/sbin/lsof -nP -iTCP:8788 -sTCP:LISTEN >/dev/null 2>&1; then
	# The packaged job takes the default port. If something already holds it —
	# a real installation of this helper, most likely — the test would be
	# measuring that process instead, so it steps aside rather than guessing.
	echo "  skipped — port 8788 is already in use"
else
	# A private copy of the payload and the plist, under a throwaway label. Both
	# carry the installed prefix as a literal — the build bakes it in — so both
	# are rewritten to point at the sandbox. Nothing here has the production
	# label or path, so a real installation on this machine is untouched.
	LSBX="$WORK/launchd-sandbox"
	mkdir -p "$LSBX"
	cp -R "$SANDBOX/." "$LSBX/"
	/usr/bin/sed -i '' "s|/usr/local/lib/whatsapp-sales-ai-copilot|${LSBX}|g" "$LSBX/ChatGPT Connector for Sales AI Copilot.app/Contents/MacOS/ChatGPT Connector"

	TEST_PLIST="$WORK/${TEST_LABEL}.plist"
	/usr/bin/sed -e "s|${LABEL}|${TEST_LABEL}|g" -e "s|/usr/local/lib/whatsapp-sales-ai-copilot|${LSBX}|g" "$PLIST" > "$TEST_PLIST"
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$TEST_PLIST" >/dev/null 2>&1 || true
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:HOME string ${HOME}" "$TEST_PLIST" >/dev/null 2>&1 || true
	/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:WHATSAPP_COPILOT_HOME string ${WHATSAPP_COPILOT_HOME}" "$TEST_PLIST" >/dev/null 2>&1 || true

	UID_="$(id -u)"
	/bin/launchctl bootout "gui/${UID_}/${TEST_LABEL}" 2>/dev/null || true
	if /bin/launchctl bootstrap "gui/${UID_}" "$TEST_PLIST" 2>/dev/null; then
		ok "launchd accepted the plist (bootstrap gui/${UID_})"
		STARTED=0
		for _ in $(seq 1 40); do
			if /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:8788/health" >/dev/null 2>&1; then STARTED=1; break; fi
			/bin/sleep 0.25
		done
		if [ "$STARTED" = "1" ]; then
			ok "the job started the helper and it answers on the default port 8788"
		else
			bad "job bootstrapped but the helper never answered on 8788; launchd says:"
			/bin/launchctl print "gui/${UID_}/${TEST_LABEL}" 2>/dev/null | /usr/bin/grep -E 'last exit code|state =' | /usr/bin/sed 's/^/       /' || true
			[ -f "$HOME/Library/Logs/whatsapp-sales-ai-copilot/helper.log" ] && /usr/bin/tail -3 "$HOME/Library/Logs/whatsapp-sales-ai-copilot/helper.log" | /usr/bin/sed 's/^/       /'
		fi
		# A job that runs as root would put the credential in root's home, where
		# the extension could never reach it. `launchctl print` does not name the
		# uid, so this asks the process itself.
		HELPER_PID="$(/usr/sbin/lsof -nP -iTCP:8788 -sTCP:LISTEN -t 2>/dev/null | /usr/bin/awk 'NR == 1')"
		RUNAS="$(/bin/ps -o user= -p "${HELPER_PID:-0}" 2>/dev/null | /usr/bin/tr -d ' ')"
		[ "$RUNAS" = "$(id -un)" ] && ok "the helper process belongs to $(id -un), not root" || bad "helper process owner is '$RUNAS', expected $(id -un)"

		# The log's location is the reason run-helper.sh exists: it has to land
		# in the home of whoever launchd started the job for.
		[ -f "$HOME/Library/Logs/whatsapp-sales-ai-copilot/helper.log" ] \
			&& ok "the job's log was written to the logged-in user's own home" \
			|| bad "the job wrote no log under this user's home"

		/bin/launchctl bootout "gui/${UID_}/${TEST_LABEL}" 2>/dev/null || true
		ok "job removed again (bootout)"
	else
		bad "launchd refused the plist"
	fi
fi

# ---------------------------------------------------------------------------
head_ "Result"
# ---------------------------------------------------------------------------
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
cat <<'EOF'

  Not covered here, and needing a person: the Installer.app window itself,
  Gatekeeper on a machine that has never seen the package, whether the job comes
  back after a real reboot, and the real Sign-in-with-ChatGPT flow in a browser.
EOF

[ "$FAIL" -eq 0 ]
