#!/bin/sh

set -eu

# Release compiler: THE version in the module SDK's wasmedgePin.json, read at
# build time — never a literal here. The compiler, the node host and the Docker
# parity container are one pin; a WasmEdge daemon IGNORES (and prunes) an AOT
# section produced by a different runtime version, so a hardcoded compiler pin
# does not merely drift, it silently ships dead bytes. This file used to say
# 0.14.1 while the pin, the host installer and the live host-01 daemon
# (.wasmedge-0.16.4) had all moved to 0.16.4 — exactly that failure.
#
# The parent flow host has no statistics context, while child nodes run with
# cost limits and therefore require gas instrumentation. Keep these profiles
# explicit and separate.
if [ "$#" -ne 3 ]; then
  echo "usage: $0 parent|child INPUT.wasm OUTPUT.wasm" >&2
  exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pin_file="$script_dir/../../../node_modules/space-data-module-sdk/src/testing/wasmedgePin.json"
if [ ! -f "$pin_file" ]; then
  echo "compile-universal-aot: missing SDK WasmEdge pin at $pin_file" >&2
  exit 69
fi
required_version=$(sed -n 's/.*"wasmedgeVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pin_file")
if [ -z "$required_version" ]; then
  echo "compile-universal-aot: $pin_file declares no wasmedgeVersion" >&2
  exit 69
fi

compiler=${WASMEDGEC_BIN:-wasmedgec}
case $("$compiler" --version) in
  *"version $required_version"*) ;;
  *)
    echo "compile-universal-aot: WasmEdge $required_version is required (SDK wasmedgePin.json)" >&2
    exit 69
    ;;
esac

compile_parent() {
  "$compiler" \
    --enable-all \
    --optimize 3 \
    --interruptible \
    --generic-binary \
    "$1" \
    "$2"
}

compile_child() {
  "$compiler" \
    --enable-all \
    --optimize 3 \
    --interruptible \
    --enable-gas-measuring \
    --generic-binary \
    "$1" \
    "$2"
}

mode=$1
case $mode in
  parent) compile_parent "$2" "$3" ;;
  child) compile_child "$2" "$3" ;;
  *)
    echo "compile-universal-aot: mode must be parent or child" >&2
    exit 64
    ;;
esac
