// Direct-surface initializer for the Emscripten command artifact.
//
// The command build runs its C++ and libc constructors from _start. A host
// that serves the direct surface (plugin_invoke_stream on a resident instance)
// never enters _start, so namespace-scope objects stay zero-filled and the
// first direct call traps with "memory access out of bounds". This unit
// exports _initialize, the entry a direct host calls once per instance before
// its first direct call (space-data-module-sdk >= 0.8.21).
//
// The link wraps __wasm_call_ctors (-Wl,--wrap=__wasm_call_ctors), so _start
// and this export reach the constructors through one guard: they run exactly
// once per instance, whichever entry a host takes first.
#if defined(__EMSCRIPTEN__)
extern "C" void __real___wasm_call_ctors(void);

extern "C" void __wrap___wasm_call_ctors(void) {
  static bool constructed = false;
  if (constructed) return;
  constructed = true;
  __real___wasm_call_ctors();
}

extern "C" __attribute__((export_name("_initialize"))) void
sdn_direct_initialize(void) {
  __wrap___wasm_call_ctors();
}
#endif
