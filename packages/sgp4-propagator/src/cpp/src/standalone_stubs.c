/*
 * Standalone-WASM stubs.
 *
 * Emscripten's sqlite amalgamation references a handful of filesystem
 * syscalls that the linker would otherwise pull from the "env" import
 * module. Because the SGP4 plugin only ever opens an in-memory database
 * (`:memory:`), these code paths are never exercised at runtime — but the
 * references must still resolve or the artifact fails the SDK 0.8.0
 * compliance check that requires `wasi_snapshot_preview1` as the sole
 * import module.
 *
 * We also stub `emscripten_notify_memory_growth` so memory growth no
 * longer escapes into "env".
 */

#include <errno.h>
#include <stdint.h>

/* ------------------------------------------------------------------------- */
/* Emscripten memory growth notifications -- no-op for standalone modules.   */
/* ------------------------------------------------------------------------- */

void emscripten_notify_memory_growth(int memory_index) {
    (void)memory_index;
}

/* ------------------------------------------------------------------------- */
/* Unused filesystem syscalls referenced by the sqlite amalgamation.         */
/* Every entry returns -EPERM (matching sqlite's expectations) so that, in   */
/* the rare case the runtime did reach one of these paths, it fails cleanly  */
/* instead of trapping.                                                      */
/* ------------------------------------------------------------------------- */

long __syscall_fchown32(long fd, long owner, long group) {
    (void)fd; (void)owner; (void)group;
    return -EPERM;
}

long __syscall_chmod(long path, long mode) {
    (void)path; (void)mode;
    return -EPERM;
}

long __syscall_fchmod(long fd, long mode) {
    (void)fd; (void)mode;
    return -EPERM;
}

long __syscall_faccessat(long dirfd, long path, long amode, long flags) {
    (void)dirfd; (void)path; (void)amode; (void)flags;
    return -EPERM;
}

long __syscall_utimensat(long dirfd, long path, long times, long flags) {
    (void)dirfd; (void)path; (void)times; (void)flags;
    return -EPERM;
}

long __syscall_unlinkat(long dirfd, long path, long flags) {
    (void)dirfd; (void)path; (void)flags;
    return -EPERM;
}

long __syscall_rmdir(long path) {
    (void)path;
    return -EPERM;
}

long __syscall_readlinkat(long dirfd, long path, long buf, long bufsize) {
    (void)dirfd; (void)path; (void)buf; (void)bufsize;
    return -EPERM;
}

long __syscall_getcwd(long buf, long size) {
    (void)buf; (void)size;
    return -EPERM;
}

long __syscall_ftruncate64(long fd, long low, long high) {
    (void)fd; (void)low; (void)high;
    return -EPERM;
}

/* ------------------------------------------------------------------------- */
/* Override POSIX fsync. SQLite calls fsync() on its in-memory DB when       */
/* committing — emscripten would otherwise route that call through the       */
/* WASI `fd_sync` import. The SDK 0.8.0 browser shim does not supply         */
/* `fd_sync`, so we short-circuit here to keep the wasm import set aligned   */
/* with the SDK's WASI subset.                                               */
/* ------------------------------------------------------------------------- */
int fsync(int fd) {
    (void)fd;
    return 0;
}

int fdatasync(int fd) {
    (void)fd;
    return 0;
}
