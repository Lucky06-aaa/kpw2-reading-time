#!/bin/sh

# Removes the service, WebView registration and library launcher.
# Reading records under /mnt/us/kpw2-reading-time are deliberately retained.

BASE="/mnt/us/kpw2-reading-time"
APP_ID="com.theo.kpw2readingtime.dashboard"
JOB="kpw2-reading-time"
LEGACY_JOB="kpw2-reading-time-test"
CONF="/etc/upstart/$JOB.conf"
LEGACY_CONF="/etc/upstart/$LEGACY_JOB.conf"
APPREG=""
LOG="$BASE/uninstall.log"

mkdir -p "$BASE"
echo "$(date): uninstaller started, uid=$(id -u)" >> "$LOG"
[ "$(id -u)" -eq 0 ] || exit 1

lipc-set-prop com.lab126.appmgrd stop "app://$APP_ID" >/dev/null 2>&1 || true
/sbin/initctl stop "$JOB" >/dev/null 2>&1 || true
/sbin/initctl stop "$LEGACY_JOB" >/dev/null 2>&1 || true

for candidate in /var/local/appreg.db /opt/var/local/appreg.db; do
    [ -f "$candidate" ] && { APPREG="$candidate"; break; }
done
if [ -n "$APPREG" ] && command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$APPREG" "BEGIN IMMEDIATE; DELETE FROM properties WHERE handlerId='$APP_ID'; DELETE FROM handlerIds WHERE handlerId='$APP_ID'; COMMIT;" >> "$LOG" 2>&1 || true
fi

root_rw=0
root_ro() {
    if [ "$root_rw" -eq 1 ]; then
        mntroot ro >/dev/null 2>&1 || /usr/sbin/mntroot ro >/dev/null 2>&1 || /sbin/mntroot ro >/dev/null 2>&1 || true
        root_rw=0
    fi
}
trap root_ro EXIT INT TERM HUP
if mntroot rw >/dev/null 2>&1 || /usr/sbin/mntroot rw >/dev/null 2>&1 || /sbin/mntroot rw >/dev/null 2>&1; then
    root_rw=1
    rm -f "$CONF" "$LEGACY_CONF"
    /sbin/initctl reload-configuration >/dev/null 2>&1 || true
fi
root_ro
trap - EXIT INT TERM HUP

rm -f "/mnt/us/documents/KPW2-reading-time.sh"
lipc-set-prop com.lab126.scanner doFullScan 1 >/dev/null 2>&1 || lipc-set-prop com.lab126.scanner triggerUpdate 1 >/dev/null 2>&1 || true
echo "$(date): uninstalled; reading data retained in $BASE" >> "$LOG"
lipc-set-prop com.lab126.system toasterMessage "KPW2 reading-time removed; data retained" >/dev/null 2>&1 || true
sync
exit 0
