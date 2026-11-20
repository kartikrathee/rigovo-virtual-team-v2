#!/bin/zsh
set -eu
cd "${0:A:h}"
workspace="${RIGOVO_WORKSPACE:-$PWD}"
exec ./bin/rigovo --mini "$workspace"
