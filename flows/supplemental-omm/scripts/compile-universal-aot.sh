#!/bin/sh

set -eu

# Release compiler: WasmEdge-0.14.1. The parent flow host has no statistics
# context, while child nodes run with cost limits and therefore require gas
# instrumentation. Keep these profiles explicit and separate.
if [ "$#" -ne 3 ]; then
  echo "usage: $0 parent|child INPUT.wasm OUTPUT.wasm" >&2
  exit 64
fi

compiler=${WASMEDGEC_BIN:-wasmedgec}
case $("$compiler" --version) in
  *"version 0.14.1"*) ;;
  *)
    echo "compile-universal-aot: WasmEdge 0.14.1 is required" >&2
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
