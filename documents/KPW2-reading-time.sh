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

# 生成数据这件事原来是在前台先跑完（0~1 秒），然后才去停旧界面。
# 现在改成后台跑，与"停界面 + 等框架稳定"并行，那 0~1 秒就被掩盖掉了。
# data.js 是"写 tmp 再 mv"的原子替换，不存在读到半个文件的问题；
# 而且下面一定会等它跑完才启动界面。
"$BASE/bin/build-dashboard-data.sh" >> "$LOG" 2>&1 &
build_pid=$!

# Stop only this private dashboard. Poll activeApp (0.2s granularity) instead of
# assuming one fixed second is enough for Mesquite to tear down on old KPW2s.
lipc-set-prop com.lab126.appmgrd stop "app://$APP_ID" >/dev/null 2>&1 || true
wait_no=0
while [ "$wait_no" -lt 30 ]; do
    current="$(active_app)"
    [ "$current" != "$APP_ID" ] && break
    wait_no=$((wait_no+1))
    sleep 0.2
done
log "previous dashboard stopped; activeApp=$(active_app) waited=${wait_no}x0.2s"

# 框架收尾留 1 秒（原来固定 2 秒）。万一这一秒不够、第一次没起来，
# 下面的重试只要 3 秒就能判定失败并立刻重来，不会像原来那样干等 8 秒。
sleep 1

# 等数据生成结束（通常已经被上面的等待掩盖掉）
wait "$build_pid"
build_rc=$?
if [ "$build_rc" != "0" ]; then
    log "WARN: data build rc=$build_rc; keeping previous data.js"
fi

attempt=1
while [ "$attempt" -le 3 ]; do
    log "start attempt=$attempt"
    lipc-set-prop com.lab126.appmgrd start "app://$APP_ID" >> "$LOG" 2>&1
    result=$?
    verify=0
    while [ "$verify" -lt 12 ]; do          # 12 * 0.25s = 3s
        current="$(active_app)"
        if [ "$current" = "$APP_ID" ]; then
            log "dashboard active on attempt=$attempt after $((verify/4)).$((verify%4*25))s"
            exit 0
        fi
        verify=$((verify+1))
        sleep 0.25
    done
    log "start attempt=$attempt did not become active; rc=$result activeApp=$(active_app)"
    [ "$attempt" -ge 3 ] && break
    lipc-set-prop com.lab126.appmgrd stop "app://$APP_ID" >/dev/null 2>&1 || true
    sleep 1
    attempt=$((attempt+1))
done

log "ERROR: dashboard failed after 3 start attempts"
exit 1
