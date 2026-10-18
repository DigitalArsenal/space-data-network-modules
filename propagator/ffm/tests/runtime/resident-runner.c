// Evidence host only: preserve one module instance across length-prefixed PIV
// calls through the public allocator/invoke ABI. No propagation lives here.
#include <wasmedge/wasmedge.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static WasmEdge_String name(const char *s) { return WasmEdge_StringWrap(s, strlen(s)); }
static void check(WasmEdge_Result r) {
  if (!WasmEdge_ResultOK(r)) { fprintf(stderr, "%s\n", WasmEdge_ResultGetMessage(r)); exit(1); }
}
static uint32_t get32(const uint8_t b[4]) { return b[0] | (uint32_t)b[1]<<8 | (uint32_t)b[2]<<16 | (uint32_t)b[3]<<24; }
int main(int argc, char **argv) {
  if (strcmp(WasmEdge_VersionGet(), "0.16.4")) { fprintf(stderr,"WasmEdge pin mismatch\n"); return 2; }
  if (argc != 2) return 2;
  WasmEdge_LogOff();
  WasmEdge_ConfigureContext *conf=WasmEdge_ConfigureCreate();
  WasmEdge_ConfigureAddProposal(conf,WasmEdge_Proposal_Threads);
  WasmEdge_LoaderContext *loader=WasmEdge_LoaderCreate(conf);
  WasmEdge_ValidatorContext *validator=WasmEdge_ValidatorCreate(conf);
  WasmEdge_ExecutorContext *executor=WasmEdge_ExecutorCreate(conf,NULL);
  WasmEdge_StoreContext *store=WasmEdge_StoreCreate();
  WasmEdge_ASTModuleContext *ast=NULL;
  check(WasmEdge_LoaderParseFromFile(loader,&ast,argv[1]));
  check(WasmEdge_ValidatorValidate(validator,ast));
  const char *guest_argv[]={"module.wasm"};
  WasmEdge_ModuleInstanceContext *wasi=WasmEdge_ModuleInstanceCreateWASI(guest_argv,1,NULL,0,NULL,0);
  check(WasmEdge_ExecutorRegisterImport(executor,store,wasi));
  WasmEdge_ModuleInstanceContext *instance=NULL;
  check(WasmEdge_ExecutorInstantiate(executor,&instance,store,ast));
  WasmEdge_MemoryInstanceContext *memory=WasmEdge_ModuleInstanceFindMemory(instance,name("memory"));
  const WasmEdge_FunctionInstanceContext *init=WasmEdge_ModuleInstanceFindFunction(instance,name("__wasm_call_ctors"));
  const WasmEdge_FunctionInstanceContext *alloc=WasmEdge_ModuleInstanceFindFunction(instance,name("plugin_alloc"));
  const WasmEdge_FunctionInstanceContext *release=WasmEdge_ModuleInstanceFindFunction(instance,name("plugin_free"));
  const WasmEdge_FunctionInstanceContext *invoke=WasmEdge_ModuleInstanceFindFunction(instance,name("plugin_invoke_stream"));
  if(!memory||!init||!alloc||!release||!invoke)return 3;
  check(WasmEdge_ExecutorInvoke(executor,init,NULL,0,NULL,0));
  uint8_t length_bytes[4];
  while(fread(length_bytes,1,4,stdin)==4) {
    uint32_t length=get32(length_bytes), padded=(length+7U)&~7U;
    if(!length||length>(1U<<28))return 4;
    uint8_t *input=malloc(length);
    if(!input||fread(input,1,length,stdin)!=length)return 4;
    WasmEdge_Value size=WasmEdge_ValueGenI32(padded+4),ptr;
    check(WasmEdge_ExecutorInvoke(executor,alloc,&size,1,&ptr,1));
    uint32_t address=WasmEdge_ValueGetI32(ptr),length_address=address+padded;
    check(WasmEdge_MemoryInstanceSetData(memory,input,address,length));free(input);
    uint8_t zero[4]={0};check(WasmEdge_MemoryInstanceSetData(memory,zero,length_address,4));
    WasmEdge_Value args[]={ptr,WasmEdge_ValueGenI32(length),WasmEdge_ValueGenI32(length_address)},response;
    check(WasmEdge_ExecutorInvoke(executor,invoke,args,3,&response,1));
    uint32_t response_address=WasmEdge_ValueGetI32(response);
    check(WasmEdge_MemoryInstanceGetData(memory,length_bytes,length_address,4));
    uint32_t response_length=get32(length_bytes);
    if(!response_address||!response_length)return 5;
    const uint8_t *output=WasmEdge_MemoryInstanceGetPointerConst(memory,response_address,response_length);
    if(!output||fwrite(length_bytes,1,4,stdout)!=4||fwrite(output,1,response_length,stdout)!=response_length)return 5;
    WasmEdge_Value free_response[]={response,WasmEdge_ValueGenI32(response_length)};
    check(WasmEdge_ExecutorInvoke(executor,release,free_response,2,NULL,0));
    WasmEdge_Value free_input[]={ptr,size};
    check(WasmEdge_ExecutorInvoke(executor,release,free_input,2,NULL,0));
  }
  WasmEdge_ModuleInstanceDelete(instance);WasmEdge_ModuleInstanceDelete(wasi);
  WasmEdge_StoreDelete(store);WasmEdge_ASTModuleDelete(ast);WasmEdge_ExecutorDelete(executor);
  WasmEdge_ValidatorDelete(validator);WasmEdge_LoaderDelete(loader);WasmEdge_ConfigureDelete(conf);
  return ferror(stdin)?1:0;
}
