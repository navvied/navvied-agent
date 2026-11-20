#!/bin/bash
[ -f .bench-pid ] && kill "$(cat .bench-pid)" 2>/dev/null || true
exit 0
