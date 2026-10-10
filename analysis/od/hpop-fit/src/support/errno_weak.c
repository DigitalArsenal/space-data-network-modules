/* wasm-ld -r cannot leave a thread-local symbol undefined, and the linked
 * units use errno (strtod, stoi). A weak definition satisfies the relocatable
 * link; the SDK's guest-link renaming skips weak symbols, and libc's own
 * errno.c.obj (which defines errno alone) is then never pulled. */
__attribute__((weak)) _Thread_local int errno = 0;
