#!/bin/sh
# Force a full reinstall (RUNME.sh takes the fast-open path when already
# installed; this env var makes it do the real reinstall instead).
KPW2RT_FORCE=1 exec /bin/sh /mnt/us/RUNME.sh
