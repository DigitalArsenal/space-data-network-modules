// WASI command and reactor hosts may both request initialization. All globals
// live until the host destroys the instance; repeated entry must not recreate
// or destroy the SDK context or resident screening indexes.
extern "C" void __real___wasm_call_ctors(void);
extern "C" void __wrap___wasm_call_ctors(void) {
    static bool initialized = false;
    if (!initialized) {
        initialized = true;
        __real___wasm_call_ctors();
    }
}
extern "C" void _initialize(void) { __wrap___wasm_call_ctors(); }
// Keep this unit on the final SDK link so LLVM preserves export_name for the
// SDK persistent WasmEdge service host.
extern "C" __attribute__((export_name("__wasm_call_ctors")))
void cqr_initialize_service(void) { __wrap___wasm_call_ctors(); }
