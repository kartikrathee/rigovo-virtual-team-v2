#!/bin/zsh
set -eu
cd "${0:A:h}"
runtime="${RIGOVO_HOME:-$PWD/.rigovo/runtime}"
mkdir -p "$runtime/data/opencode/log"
: >> "$runtime/data/opencode/log/opencode.log"
print 'Rigovo v2 native runtime logs — shared with Codex'
exec tail -n 30 -F "$runtime/data/opencode/log/opencode.log"
