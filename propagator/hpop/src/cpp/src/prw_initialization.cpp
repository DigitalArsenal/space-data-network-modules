// Keep this thin unit on the final link: LLVM's relocatable Wasm link drops
// export_name metadata. The SDK's persistent service host looks up this exact
// name. Both it and the command CRT reach the same per-instance constructor
// guard, so neither skipped nor repeated C++ initialization is possible.
extern "C" void __wrap___wasm_call_ctors(void);
extern "C" __attribute__((export_name("__wasm_call_ctors")))
void hpop_initialize_service(void) {
    __wrap___wasm_call_ctors();
}
