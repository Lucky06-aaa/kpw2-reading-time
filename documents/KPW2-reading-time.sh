#!/bin/sh

BASE="/mnt/us/kpw2-reading-time"
APP_ID="com.theo.kpw2readingtime.dashboard"
LOG="$BASE/dashboard-launch.log"
LOCK="$BASE/.dashboard-launch.lock"
PIDFILE="$LOCK/pid"

log() {
    echo "$(date): $*" >> "$LOG"
}

active_app() {
    lipc-get-prop com.lab126.appmgrd activeApp 2>/dev/null
}

release_lock() {
    rm -f "$PIDFILE" 2>/dev/null || true
    rmdir "$LOCK" 2>/dev/null || true
}

mkdir -p "$BASE"
log "dashboard launch requested, pid=$$"

# Ignore a second tap while an earlier launch is still running. If a previous
# launcher was interrupted, remove only its private stale lock and continue.
if ! mkdir "$LOCK" 2>/dev/null; then
    old_pid=""
    [ -f "$PIDFILE" ] && old_pid="$(cat "$PIDFILE" 2>/dev/null)"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
        log "launch already in progress, pid=$old_pid; duplicate tap ignored"
        exit 0
    fi
    log "removing stale launch lock${old_pid:+, pid=$old_pid}"
    rm -f "$PIDFILE" 2>/dev/null || true
    rmdir "$LOCK" 2>/dev/null || true
    if ! mkdir "$LOCK" 2>/dev/null; then
        log "ERROR: cannot acquire launch lock"
        exit 1
    fi
fi
echo "$$" > "$PIDFILE"
trap 'release_lock' EXIT HUP INT TERM

if [ ! -x "$BASE/bin/build-dashboard-data.sh" ]; then
    log "ERROR: data builder missing"
    exit 1
fi

build_started="$(date +%s 2>/dev/null)"
if ! "$BASE/bin/build-dashboard-data.sh" >> "$LOG" 2>&1; then
    log "ERROR: dashboard data build failed"
    exit 1
fi
build_finished="$(date +%s 2>/dev/null)"
case "$build_started:$build_finished" in
    *[!0-9:]*|:*) log "dashboard data build completed" ;;
    *) log "dashboard data build completed in $((build_finished-build_started))s" ;;
esac

# Stop only this private dashboard. Poll activeApp instead of assuming one
# fixed second is enough for Mesquite to tear down on older KPW2 hardware.
lipc-set-prop com.lab126.appmgrd stop "app://$APP_ID" >/dev/null 2>&1 || true
wait_no=0
while [ "$wait_no" -lt 6 ]; do
    current="$(active_app)"
    [ "$current" != "$APP_ID" ] && break
    wait_no=$((wait_no+1))
    sleep 1
done
log "previous dashboard stopped; activeApp=$(active_app) wait=${wait_no}s"

# Give the framework a short settling interval after leaving the native reader
# or an earlier WebView, then retry once if the first start does not become the
# active app.
sleep 2
attempt=1
while [ "$attempt" -le 2 ]; do
    log "start attempt=$attempt"
    lipc-set-prop com.lab126.appmgrd start "app://$APP_ID" >> "$LOG" 2>&1
    result=$?
    verify=0
    while [ "$verify" -lt 8 ]; do
        current="$(active_app)"
        if [ "$current" = "$APP_ID" ]; then
            log "dashboard active on attempt=$attempt after ${verify}s"
            exit 0
        fi
        verify=$((verify+1))
        sleep 1
    done
    log "start attempt=$attempt did not become active; rc=$result activeApp=$(active_app)"
    [ "$attempt" -ge 2 ] && break
    lipc-set-prop com.lab126.appmgrd stop "app://$APP_ID" >/dev/null 2>&1 || true
    sleep 2
    attempt=$((attempt+1))
done

log "ERROR: dashboard failed after two start attempts"
exit 1
