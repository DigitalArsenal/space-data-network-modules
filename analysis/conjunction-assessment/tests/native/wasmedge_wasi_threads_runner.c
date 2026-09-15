/* Verification host for the canonical WASI preview1 threads ABI.
 * https://github.com/WebAssembly/wasi-threads#detailed-design-discussion
 * Only hosting, shared-memory ownership and binary SDK transport live here.
 * The unchanged module.wasm performs all parsing and numerical evaluation.
 */
#include <wasmedge/wasmedge.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Thread Thread;
typedef struct {
  WasmEdge_ConfigureContext *config;
  WasmEdge_ASTModuleContext *ast;
  WasmEdge_StoreContext *store;
  WasmEdge_MemoryInstanceContext *memory;
  pthread_mutex_t lock;
  uint32_t next_tid, spawn_count;
  Thread *threads;
} Host;
struct Thread {
  Host *host;
  WasmEdge_ExecutorContext *executor;
  WasmEdge_ModuleInstanceContext *module;
  pthread_t thread;
  uint32_t tid, arg;
  Thread *next;
};

static void check(const char *step, WasmEdge_Result result) {
  if (!WasmEdge_ResultOK(result)) {
    fprintf(stderr, "%s: %s (0x%x)\n", step,
            WasmEdge_ResultGetMessage(result), WasmEdge_ResultGetCode(result));
    /* A trap in any thread terminates the entire WASI process. */
    exit(1);
  }
}
static WasmEdge_FunctionInstanceContext *function(WasmEdge_ModuleInstanceContext *m, const char *name) {
  WasmEdge_String s = WasmEdge_StringCreateByCString(name);
  WasmEdge_FunctionInstanceContext *f = WasmEdge_ModuleInstanceFindFunction(m, s);
  WasmEdge_StringDelete(s);
  return f;
}
static void call(WasmEdge_ExecutorContext *e, WasmEdge_ModuleInstanceContext *m,
                 const char *name, WasmEdge_Value *args, uint32_t argc,
                 WasmEdge_Value *results, uint32_t resultc) {
  WasmEdge_FunctionInstanceContext *f = function(m, name);
  if (!f) { fprintf(stderr, "missing guest function: %s\n", name); exit(1); }
  check(name, WasmEdge_ExecutorInvoke(e, f, args, argc, results, resultc));
}
static void *run_thread(void *data) {
  Thread *t = data;
  WasmEdge_Value args[] = {WasmEdge_ValueGenI32(t->tid), WasmEdge_ValueGenI32(t->arg)};
  call(t->executor, t->module, "wasi_thread_start", args, 2, NULL, 0);
  return NULL;
}
static WasmEdge_Result spawn_thread(void *data, const WasmEdge_CallingFrameContext *frame,
                                  const WasmEdge_Value *args, WasmEdge_Value *results) {
  (void)frame;
  Host *h = data;
  results[0] = WasmEdge_ValueGenI32(-1);
  Thread *t = calloc(1, sizeof(*t));
  if (!t) return WasmEdge_Result_Success;
  t->host = h;
  t->arg = (uint32_t)WasmEdge_ValueGetI32(args[0]);
  t->executor = WasmEdge_ExecutorCreate(h->config, NULL);
  pthread_mutex_lock(&h->lock);
  WasmEdge_Result result = WasmEdge_ExecutorInstantiate(t->executor, &t->module, h->store, h->ast);
  bool ready = WasmEdge_ResultOK(result) && t->module && h->next_tid < (1U << 29);
  if (ready) {
    t->tid = h->next_tid++;
    ready = pthread_create(&t->thread, NULL, run_thread, t) == 0;
  }
  if (ready) { t->next = h->threads; h->threads = t; ++h->spawn_count; }
  pthread_mutex_unlock(&h->lock);
  if (!ready) {
    if (t->module) WasmEdge_ModuleInstanceDelete(t->module);
    WasmEdge_ExecutorDelete(t->executor);
    free(t);
  } else results[0] = WasmEdge_ValueGenI32(t->tid);
  return WasmEdge_Result_Success;
}
static bool name_is(WasmEdge_String name, const char *text) {
  return name.Length == strlen(text) && !memcmp(name.Buf, text, name.Length);
}
static WasmEdge_ModuleInstanceContext *new_module(const char *name) {
  WasmEdge_String n = WasmEdge_StringCreateByCString(name);
  WasmEdge_ModuleInstanceContext *m = WasmEdge_ModuleInstanceCreate(n);
  WasmEdge_StringDelete(n);
  return m;
}
static void add_memory(Host *h, WasmEdge_ModuleInstanceContext *env) {
  uint32_t count = WasmEdge_ASTModuleListImportsLength(h->ast);
  const WasmEdge_ImportTypeContext **imports = calloc(count, sizeof(*imports));
  if (!imports) exit(1);
  WasmEdge_ASTModuleListImports(h->ast, imports, count);
  for (uint32_t i = 0; i < count; ++i) {
    if (WasmEdge_ImportTypeGetExternalType(imports[i]) != WasmEdge_ExternalType_Memory) continue;
    if (!name_is(WasmEdge_ImportTypeGetModuleName(imports[i]), "env") ||
        !name_is(WasmEdge_ImportTypeGetExternalName(imports[i]), "memory") || h->memory) {
      fprintf(stderr, "Expected one env.memory import\n"); exit(1);
    }
    const WasmEdge_MemoryTypeContext *type = WasmEdge_ImportTypeGetMemoryType(h->ast, imports[i]);
    WasmEdge_Limit limit = WasmEdge_MemoryTypeGetLimit(type);
    if (!limit.Shared || !limit.HasMax) { fprintf(stderr, "Expected bounded shared memory\n"); exit(1); }
    h->memory = WasmEdge_MemoryInstanceCreate(type);
    WasmEdge_String name = WasmEdge_StringCreateByCString("memory");
    WasmEdge_ModuleInstanceAddMemory(env, name, h->memory);
    WasmEdge_StringDelete(name);
  }
  free(imports);
  if (!h->memory) { fprintf(stderr, "Missing shared memory import\n"); exit(1); }
}
static uint32_t alloc(WasmEdge_ExecutorContext *e, WasmEdge_ModuleInstanceContext *m, uint32_t n) {
  WasmEdge_Value a = WasmEdge_ValueGenI32(n), r;
  call(e, m, "plugin_alloc", &a, 1, &r, 1);
  uint32_t p = (uint32_t)WasmEdge_ValueGetI32(r);
  if (!p && n) { fprintf(stderr, "Guest allocation failed\n"); exit(1); }
  return p;
}
static void release(WasmEdge_ExecutorContext *e, WasmEdge_ModuleInstanceContext *m, uint32_t p, uint32_t n) {
  WasmEdge_Value a[] = {WasmEdge_ValueGenI32(p), WasmEdge_ValueGenI32(n)};
  call(e, m, "plugin_free", a, 2, NULL, 0);
}
static uint32_t little_u32(const uint8_t b[4]) {
  return (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
}
static void reap_threads(Host *h) {
  /* SDK calls are synchronous: after each response, join native workers before
   * accepting the next request. This bounds retained instances across calls. */
  for (;;) {
    pthread_mutex_lock(&h->lock);
    Thread *threads = h->threads;
    h->threads = NULL;
    pthread_mutex_unlock(&h->lock);
    if (!threads) return;
    for (Thread *t = threads; t;) {
      Thread *next = t->next;
      pthread_join(t->thread, NULL);
      WasmEdge_ModuleInstanceDelete(t->module);
      WasmEdge_ExecutorDelete(t->executor);
      free(t);
      t = next;
    }
  }
}
static void serve(Host *h, WasmEdge_ExecutorContext *e, WasmEdge_ModuleInstanceContext *m) {
  for (;;) {
    uint8_t prefix[4];
    size_t n = fread(prefix, 1, 4, stdin);
    if (!n && feof(stdin)) return;
    if (n != 4) { fprintf(stderr, "Incomplete SDK frame prefix\n"); exit(1); }
    uint32_t size = little_u32(prefix);
    if (size > 64U * 1024 * 1024) { fprintf(stderr, "SDK request exceeds 64 MiB host cap\n"); exit(1); }
    uint8_t *bytes = malloc(size ? size : 1);
    if (!bytes || fread(bytes, 1, size, stdin) != size) { fprintf(stderr, "Incomplete SDK frame\n"); exit(1); }
    uint32_t p = alloc(e, m, size), sp = alloc(e, m, 4);
    check("request write", WasmEdge_MemoryInstanceSetData(h->memory, bytes, p, size));
    free(bytes);
    WasmEdge_Value a[] = {WasmEdge_ValueGenI32(p), WasmEdge_ValueGenI32(size), WasmEdge_ValueGenI32(sp)}, r;
    call(e, m, "plugin_invoke_stream", a, 3, &r, 1);
    reap_threads(h);
    uint32_t result_ptr = (uint32_t)WasmEdge_ValueGetI32(r);
    check("response size", WasmEdge_MemoryInstanceGetData(h->memory, prefix, sp, 4));
    uint32_t result_size = little_u32(prefix);
    if (result_size > 64U * 1024 * 1024) { fprintf(stderr, "SDK response exceeds 64 MiB host cap\n"); exit(1); }
    bytes = malloc(result_size ? result_size : 1);
    if (!bytes) exit(1);
    check("response read", WasmEdge_MemoryInstanceGetData(h->memory, bytes, result_ptr, result_size));
    if (fwrite(prefix, 1, 4, stdout) != 4 || fwrite(bytes, 1, result_size, stdout) != result_size || fflush(stdout)) exit(1);
    free(bytes);
    release(e, m, result_ptr, result_size); release(e, m, sp, 4); release(e, m, p, size);
  }
}
int main(int argc, char **argv) {
  int file = 1;
  if (argc > 1 && !strcmp(argv[1], "--version")) { printf("WasmEdge wasi-threads host %s\n", WasmEdge_VersionGet()); return 0; }
  if (argc > 1 && !strcmp(argv[1], "--enable-threads")) ++file;
  if (argc <= file) { fprintf(stderr, "usage: %s [--enable-threads] module.wasm [--serve-plugin-invoke]\n", argv[0]); return 2; }
  bool resident = argc > file + 1 && !strcmp(argv[file + 1], "--serve-plugin-invoke");
  Host h = {.config = WasmEdge_ConfigureCreate(), .store = WasmEdge_StoreCreate(), .next_tid = 1};
  pthread_mutex_init(&h.lock, NULL);
  WasmEdge_ConfigureAddProposal(h.config, WasmEdge_Proposal_Threads);
  WasmEdge_LoaderContext *loader = WasmEdge_LoaderCreate(h.config);
  WasmEdge_ValidatorContext *validator = WasmEdge_ValidatorCreate(h.config);
  WasmEdge_ExecutorContext *executor = WasmEdge_ExecutorCreate(h.config, NULL);
  check("parse", WasmEdge_LoaderParseFromFile(loader, &h.ast, argv[file]));
  check("validate", WasmEdge_ValidatorValidate(validator, h.ast));
  WasmEdge_ModuleInstanceContext *wasi = WasmEdge_ModuleInstanceCreateWASI((const char *const *)(argv + file), (uint32_t)(argc - file), NULL, 0, NULL, 0);
  check("WASI registration", WasmEdge_ExecutorRegisterImport(executor, h.store, wasi));
  WasmEdge_ModuleInstanceContext *env = new_module("env");
  add_memory(&h, env);
  check("memory registration", WasmEdge_ExecutorRegisterImport(executor, h.store, env));
  WasmEdge_ModuleInstanceContext *threads = new_module("wasi");
  WasmEdge_ValType i32 = WasmEdge_ValTypeGenI32();
  WasmEdge_FunctionTypeContext *type = WasmEdge_FunctionTypeCreate(&i32, 1, &i32, 1);
  WasmEdge_FunctionInstanceContext *spawn = WasmEdge_FunctionInstanceCreate(type, spawn_thread, &h, 0);
  WasmEdge_String spawn_name = WasmEdge_StringCreateByCString("thread-spawn");
  WasmEdge_ModuleInstanceAddFunction(threads, spawn_name, spawn);
  WasmEdge_StringDelete(spawn_name); WasmEdge_FunctionTypeDelete(type);
  check("thread registration", WasmEdge_ExecutorRegisterImport(executor, h.store, threads));
  WasmEdge_ModuleInstanceContext *module = NULL;
  check("instantiate", WasmEdge_ExecutorInstantiate(executor, &module, h.store, h.ast));
  if (resident) {
    if (function(module, "_initialize")) call(executor, module, "_initialize", NULL, 0, NULL, 0);
    else if (function(module, "__wasm_call_ctors")) call(executor, module, "__wasm_call_ctors", NULL, 0, NULL, 0);
    serve(&h, executor, module);
  } else call(executor, module, "_start", NULL, 0, NULL, 0);
  uint32_t exit_code = WasmEdge_ModuleInstanceWASIGetExitCode(wasi);
  reap_threads(&h);
  fprintf(stderr, "wasi-thread-spawn count=%u\n", h.spawn_count);
  WasmEdge_ModuleInstanceDelete(module); WasmEdge_StoreDelete(h.store);
  WasmEdge_ModuleInstanceDelete(threads); WasmEdge_ModuleInstanceDelete(env); WasmEdge_ModuleInstanceDelete(wasi);
  WasmEdge_ASTModuleDelete(h.ast); WasmEdge_ExecutorDelete(executor);
  WasmEdge_ValidatorDelete(validator); WasmEdge_LoaderDelete(loader); WasmEdge_ConfigureDelete(h.config);
  pthread_mutex_destroy(&h.lock);
  return (int)exit_code;
}
