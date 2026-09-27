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
// The threads sysroot's crt1-command sets up the main thread's pthread record
// in _start; a host that enters through _initialize never runs _start, so it
// is set up here before the constructors, exactly once.
extern "C" __attribute__((weak)) void __wasi_init_tp(void);
extern "C" void _initialize(void) {
    static bool thread_pointer_ready = false;
    if (!thread_pointer_ready) {
        thread_pointer_ready = true;
        if (__wasi_init_tp) __wasi_init_tp();
    }
    __wrap___wasm_call_ctors();
}
// The __wasm_call_ctors export for command-surface direct and persistent
// service hosts comes from the SDK (0.8.21+) invoke glue; it resolves through
// the --wrap above, so both entries share this unit's once-only guard.
