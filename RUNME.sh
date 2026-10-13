#!/bin/sh

# KPW2 reading-time adaptation installer.
# Verified target: Kindle Paperwhite 2 (pinot), firmware 5.12.2.2, KindleBreak jailbreak.

BASE="/mnt/us/kpw2-reading-time"
LEGACY_BASE="/mnt/us/kpw2-reading-time-test"
BIN="$BASE/bin"
DASH="$BASE/dashboard"
APP_ID="com.theo.kpw2readingtime.dashboard"
JOB="kpw2-reading-time"
LEGACY_JOB="kpw2-reading-time-test"
CONF="/etc/upstart/$JOB.conf"
LEGACY_CONF="/etc/upstart/$LEGACY_JOB.conf"
PAYLOAD_CONF="$BASE/upstart/$JOB.conf"
APPREG=""
LOG="$BASE/install.log"
LAUNCHER="/mnt/us/documents/KPW2-reading-time.sh"

toast() {
    lipc-set-prop com.lab126.system toasterMessage "$1" >/dev/null 2>&1 || true
}

fail() {
    echo "$(date): ERROR: $1" >> "$LOG"
    toast "KPW2 reading-time install failed"
    exit 1
}

root_rw=0
root_ro() {
    if [ "$root_rw" -eq 1 ]; then
        mntroot ro >/dev/null 2>&1 || /usr/sbin/mntroot ro >/dev/null 2>&1 || /sbin/mntroot ro >/dev/null 2>&1 || true
        root_rw=0
    fi
}

mkdir -p "$BASE" "$BASE/backups" || exit 1

# --- serialize concurrent `;log runme` taps ---------------------------------
# Without this, two quick taps started two FULL reinstalls that clobbered each
# other (the first tap appeared to do nothing, a second tap was needed). If a
# previous runme is still going, just make sure the dashboard opens and get out
# of the way — the other instance owns the lock and will finish install/launch.
RUNME_LOCK="$BASE/.runme.lock"
if ! mkdir "$RUNME_LOCK" 2>/dev/null; then
    exec "$LAUNCHER"
fi
trap 'rmdir "$RUNME_LOCK" 2>/dev/null || true' EXIT HUP INT TERM

echo "$(date): installer started, uid=$(id -u)" >> "$LOG"

[ "$(id -u)" -eq 0 ] || fail "not root; launch with ;log runme"
[ -x /usr/bin/mesquite ] || fail "Mesquite unavailable"
[ -x /sbin/initctl ] || fail "Upstart unavailable"
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 unavailable"
command -v lipc-get-prop >/dev/null 2>&1 || fail "LIPC unavailable"

for required in \
    "$BIN/kpw2-reading-time-daemon.sh" \
    "$BIN/build-dashboard-data.sh" \
    "$DASH/config.xml" \
    "$DASH/index.html" \
    "$DASH/style.css" \
    "$DASH/app.js" \
    "$PAYLOAD_CONF" \
    "$LAUNCHER"; do
    [ -f "$required" ] || fail "missing payload: $required"
done

# --- diagnostics: record exactly what the device sees in the dashboard dir ---
{
    echo "$(date): === dashboard file check (device view) ==="
    for f in index.html style.css app.js data.js covers.js; do
        if [ -f "$DASH/$f" ]; then
            echo "$(date): $f size=$(stat -c%s "$DASH/$f" 2>/dev/null) md5=$(md5sum "$DASH/$f" 2>/dev/null | cut -d' ' -f1)"
        else
            echo "$(date): $f MISSING"
        fi
    done
    echo "$(date): style.css appearance-fix=$(grep -c 'webkit-appearance' "$DASH/style.css" 2>/dev/null)"
    echo "$(date): app.js bookdetail=$(grep -c 'renderBookDetail' "$DASH/app.js" 2>/dev/null)"
    echo "$(date): app.js backZone=$(grep -c 'backZone' "$DASH/app.js" 2>/dev/null)"
} >> "$LOG"

for candidate in /var/local/appreg.db /opt/var/local/appreg.db; do
    [ -f "$candidate" ] && { APPREG="$candidate"; break; }
done
[ -n "$APPREG" ] || fail "appreg.db not found"

# --- fast-open path --------------------------------------------------------
# `;log runme` is used almost every time just to OPEN the dashboard. The full
# reinstall above (stop daemon, rebuild data in the foreground, re-register the
# app, restart the daemon, then launch) used to run on EVERY open and took ~8s.
# If we are already installed, skip straight to opening the dashboard so the tap
# feels instant and there is no second-tap race. Force a real reinstall with the
# KUAL "Reinstall Service" menu item (sets KPW2RT_FORCE=1) or by the env var.
if [ "${KPW2RT_FORCE}" != "1" ] && [ -f "$CONF" ] && \
   sqlite3 "$APPREG" "SELECT 1 FROM properties WHERE handlerId='$APP_ID' AND name='command' LIMIT 1;" 2>/dev/null | grep -q 1; then
    echo "$(date): already installed; fast-open path" >> "$LOG"
    # make sure the background recorder daemon is running
    if ! /sbin/initctl status "$JOB" 2>/dev/null | grep -q "start/running"; then
        /sbin/initctl start "$JOB" >/dev/null 2>&1 || true
    fi
    # bust any WebView cache of the dashboard files so a freshly pushed
    # index/style/app is picked up on this open
    touch "$DASH/index.html" "$DASH/style.css" "$DASH/app.js" 2>/dev/null || true
    sync
    rmdir "$RUNME_LOCK" 2>/dev/null || true
    exec "$LAUNCHER"
fi

/sbin/initctl stop "$JOB" >/dev/null 2>&1 || true
/sbin/initctl stop "$LEGACY_JOB" >/dev/null 2>&1 || true

stamp="$(date +%Y%m%d-%H%M%S)"
if [ ! -f "$BASE/reading-time.tsv" ] && [ -f "$LEGACY_BASE/reading-time.tsv" ]; then
    cp "$LEGACY_BASE/reading-time.tsv" "$BASE/reading-time.tsv" || fail "cannot migrate legacy reading data"
    echo "$(date): migrated reading data from $LEGACY_BASE" >> "$LOG"
fi
if [ -f "$BASE/reading-time.tsv" ]; then
    cp "$BASE/reading-time.tsv" "$BASE/backups/reading-time-before-$stamp.tsv" || fail "cannot back up reading data"
else
    printf 'date\tbook_id\tseconds\ttitle\n' > "$BASE/reading-time.tsv" || fail "cannot create reading data"
fi
cp "$APPREG" "$BASE/backups/appreg-before-$stamp.db" 2>/dev/null || true
[ -f "$CONF" ] && cp "$CONF" "$BASE/backups/$JOB-$stamp.conf" 2>/dev/null || true
[ -f "$LEGACY_CONF" ] && cp "$LEGACY_CONF" "$BASE/backups/$LEGACY_JOB-$stamp.conf" 2>/dev/null || true

chmod 755 "$BIN/kpw2-reading-time-daemon.sh" "$BIN/build-dashboard-data.sh" "$LAUNCHER" || fail "cannot set executable permissions"
find "$DASH" -type f -exec chmod 644 {} \; 2>/dev/null || true

lipc-set-prop com.lab126.appmgrd stop "app://$APP_ID" >/dev/null 2>&1 || true

trap 'root_ro; rmdir "$RUNME_LOCK" 2>/dev/null || true' EXIT INT TERM HUP
if mntroot rw >/dev/null 2>&1 || /usr/sbin/mntroot rw >/dev/null 2>&1 || /sbin/mntroot rw >/dev/null 2>&1; then
    root_rw=1
else
    fail "cannot remount rootfs read-write"
fi
cp "$PAYLOAD_CONF" "$CONF.new" || fail "cannot stage Upstart job"
chmod 644 "$CONF.new"
mv "$CONF.new" "$CONF" || fail "cannot install Upstart job"
rm -f "$LEGACY_CONF"
/sbin/initctl reload-configuration >/dev/null 2>&1 || true
root_ro
# keep a trap alive so the runme lock is always released on exit (root_ro is a
# no-op now that rootfs is already read-only again)
trap 'rmdir "$RUNME_LOCK" 2>/dev/null || true' EXIT

sqlite3 "$APPREG" <<EOF
BEGIN IMMEDIATE;
INSERT OR IGNORE INTO interfaces(interface) VALUES('application');
INSERT OR IGNORE INTO handlerIds(handlerId) VALUES('$APP_ID');
INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$APP_ID','lipcId','$APP_ID');
INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$APP_ID','command','/usr/bin/mesquite -l $APP_ID -c file://$DASH/');
INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$APP_ID','supportedOrientation','U');
INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$APP_ID','unloadPolicy','unloadOnPause');
INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$APP_ID','extend-start','Y');
INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$APP_ID','maxLoadTime','60');
INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$APP_ID','maxGoTime','60');
INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$APP_ID','maxPauseTime','10');
INSERT OR REPLACE INTO properties(handlerId,name,value) VALUES('$APP_ID','maxUnloadTime','10');
COMMIT;
EOF
[ "$?" -eq 0 ] || fail "cannot register WebView application"

"$BIN/build-dashboard-data.sh" >> "$LOG" 2>&1 || fail "cannot build initial dashboard data"
/sbin/initctl start "$JOB" >> "$LOG" 2>&1 || /sbin/initctl restart "$JOB" >> "$LOG" 2>&1 || fail "cannot start timer service"

lipc-set-prop com.lab126.scanner doFullScan 1 >/dev/null 2>&1 || lipc-set-prop com.lab126.scanner triggerUpdate 1 >/dev/null 2>&1 || true
echo "$(date): installation complete" >> "$LOG"
toast "KPW2 reading-time installed"
# Also open the dashboard WebView so ';log runme' launches it directly
# Bump mtimes + sync so the freshly copied dashboard files are really picked up
# instead of a stale cached copy from an earlier launch.
touch "$DASH/index.html" "$DASH/style.css" "$DASH/app.js" 2>/dev/null || true
sync

"$LAUNCHER" >> "$LOG" 2>&1 || true
sync
exit 0
