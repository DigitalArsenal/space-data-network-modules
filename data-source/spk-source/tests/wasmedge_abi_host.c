/*
 * A WasmEdge host for the propagator ABI's DIRECT exports.
 *
 * The SDK's WasmEdge runners speak the invoke envelope over stdin; nothing in
 * them calls `plugin_init_ephemeris`, which takes a pointer to container bytes
 * in guest memory. This host does exactly what the engine and the browser lane
 * do — plugin_alloc, copy the bytes in, call the export, read the
 * OrbProStateVector back out — through the WasmEdge C API, so the same
 * artifact can be measured under native and container WasmEdge.
 *
 * It computes nothing. Every number it prints came out of the guest; the bytes
 * of each state vector are printed raw, as hex, so the comparison across
 * runtimes is a byte identity and not a decimal round trip.
 *
 *   wasmedge_abi_host <module.wasm> <fixtures dir> <op>...
 *     init:<file>:<format>   plugin_init_ephemeris -> "init <file> <format> <rc> <count>"
 *     prop:<jd hex>:<index>  plugin_propagate      -> "prop <index> <rc> <64 bytes hex>"
 *
 * <module.wasm> must already be loadable (the publication trailer stripped);
 * <jd hex> is the 16 hex digits of the IEEE-754 bits of the Julian date.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <wasmedge/wasmedge.h>

static WasmEdge_VMContext *vm;
static WasmEdge_MemoryInstanceContext *memory;

static int fail(const char *what, WasmEdge_Result r) {
    fprintf(stderr, "%s: %s\n", what, WasmEdge_ResultGetMessage(r));
    return 2;
}

/* Execute an export; every one this host calls returns at most one value. */
static int call(const char *name, const WasmEdge_Value *params, uint32_t n,
                WasmEdge_Value *ret, uint32_t nret) {
    WasmEdge_String fn = WasmEdge_StringCreateByCString(name);
    WasmEdge_Result r = WasmEdge_VMExecute(vm, fn, params, n, ret, nret);
    WasmEdge_StringDelete(fn);
    if (!WasmEdge_ResultOK(r)) return fail(name, r);
    return 0;
}

static int alloc(uint32_t size, uint32_t *out) {
    WasmEdge_Value p = WasmEdge_ValueGenI32((int32_t)size), r;
    if (call("plugin_alloc", &p, 1, &r, 1)) return 2;
    *out = (uint32_t)WasmEdge_ValueGetI32(r);
    return *out == 0 ? 2 : 0;
}

static int release(uint32_t ptr, uint32_t size) {
    WasmEdge_Value p[2] = {WasmEdge_ValueGenI32((int32_t)ptr), WasmEdge_ValueGenI32((int32_t)size)};
    return call("plugin_free", p, 2, NULL, 0);
}

static int entity_count(int32_t *out) {
    WasmEdge_Value r;
    if (call("plugin_entity_count", NULL, 0, &r, 1)) return 2;
    *out = WasmEdge_ValueGetI32(r);
    return 0;
}

static int op_init(const char *dir, char *arg) {
    char *sep = strrchr(arg, ':');
    if (!sep) return 2;
    *sep = '\0';
    const uint32_t format = (uint32_t)strtoul(sep + 1, NULL, 10);
    char path[4096];
    snprintf(path, sizeof(path), "%s/%s", dir, arg);
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); return 2; }
    fseek(f, 0, SEEK_END);
    const long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *bytes = malloc((size_t)len);
    if (!bytes || fread(bytes, 1, (size_t)len, f) != (size_t)len) { fclose(f); return 2; }
    fclose(f);

    uint32_t ptr = 0;
    if (alloc((uint32_t)len, &ptr)) return 2;
    WasmEdge_Result r = WasmEdge_MemoryInstanceSetData(memory, bytes, ptr, (uint32_t)len);
    free(bytes);
    if (!WasmEdge_ResultOK(r)) return fail("memory write", r);
    WasmEdge_Value p[3] = {WasmEdge_ValueGenI32((int32_t)ptr), WasmEdge_ValueGenI32((int32_t)len),
                           WasmEdge_ValueGenI32((int32_t)format)};
    WasmEdge_Value ret;
    if (call("plugin_init_ephemeris", p, 3, &ret, 1)) return 2;
    if (release(ptr, (uint32_t)len)) return 2;
    int32_t count = 0;
    if (entity_count(&count)) return 2;
    printf("init %s %u %d %d\n", arg, format, WasmEdge_ValueGetI32(ret), count);
    return 0;
}

static int op_prop(char *arg) {
    char *sep = strrchr(arg, ':');
    if (!sep) return 2;
    *sep = '\0';
    const uint32_t index = (uint32_t)strtoul(sep + 1, NULL, 10);
    uint64_t bits = strtoull(arg, NULL, 16);
    double jd;
    memcpy(&jd, &bits, sizeof jd);

    enum { kState = 64 };
    uint32_t ptr = 0;
    if (alloc(kState, &ptr)) return 2;
    WasmEdge_Value p[3] = {WasmEdge_ValueGenF64(jd), WasmEdge_ValueGenI32((int32_t)index),
                           WasmEdge_ValueGenI32((int32_t)ptr)};
    WasmEdge_Value ret;
    if (call("plugin_propagate", p, 3, &ret, 1)) return 2;
    uint8_t state[kState];
    WasmEdge_Result r = WasmEdge_MemoryInstanceGetData(memory, state, ptr, kState);
    if (!WasmEdge_ResultOK(r)) return fail("memory read", r);
    if (release(ptr, kState)) return 2;
    printf("prop %u %d ", index, WasmEdge_ValueGetI32(ret));
    for (int i = 0; i < kState; ++i) printf("%02x", state[i]);
    printf("\n");
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: %s <module.wasm> <fixtures dir> <op>...\n", argv[0]);
        return 2;
    }
    printf("wasmedge %s\n", WasmEdge_VersionGet());

    /* The SDK compiles on the wasm32-wasip1-threads toolchain, so the memory
     * is declared shared even for a sequential guest: the same proposal the
     * SDK's own launch plan enables with `--enable-threads`. */
    WasmEdge_ConfigureContext *conf = WasmEdge_ConfigureCreate();
    WasmEdge_ConfigureAddProposal(conf, WasmEdge_Proposal_Threads);
    WasmEdge_ConfigureAddHostRegistration(conf, WasmEdge_HostRegistration_Wasi);
    vm = WasmEdge_VMCreate(conf, NULL);
    WasmEdge_ModuleInstanceContext *wasi =
        WasmEdge_VMGetImportModuleContext(vm, WasmEdge_HostRegistration_Wasi);
    const char *args[] = {"module"};
    WasmEdge_ModuleInstanceInitWASI(wasi, args, 1, NULL, 0, NULL, 0);

    WasmEdge_Result r = WasmEdge_VMLoadWasmFromFile(vm, argv[1]);
    if (!WasmEdge_ResultOK(r)) return fail("load", r);
    if (!WasmEdge_ResultOK(r = WasmEdge_VMValidate(vm))) return fail("validate", r);
    if (!WasmEdge_ResultOK(r = WasmEdge_VMInstantiate(vm))) return fail("instantiate", r);

    WasmEdge_String name = WasmEdge_StringCreateByCString("memory");
    memory = WasmEdge_ModuleInstanceFindMemory(WasmEdge_VMGetActiveModule(vm), name);
    WasmEdge_StringDelete(name);
    if (!memory) { fprintf(stderr, "no exported memory\n"); return 2; }

    /* The direct surface runs the constructors once and never `_start`, which
     * is the stdin-driven invoke loop — the same order the SDK's browser
     * harness uses for a command artifact served directly. */
    if (call("__wasm_call_ctors", NULL, 0, NULL, 0)) return 2;

    for (int i = 3; i < argc; ++i) {
        int rc = 2;
        if (strncmp(argv[i], "init:", 5) == 0) rc = op_init(argv[2], argv[i] + 5);
        else if (strncmp(argv[i], "prop:", 5) == 0) rc = op_prop(argv[i] + 5);
        if (rc) { fprintf(stderr, "op failed: %s\n", argv[i]); return rc; }
    }
    WasmEdge_VMDelete(vm);
    WasmEdge_ConfigureDelete(conf);
    return 0;
}
