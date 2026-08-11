/*
 * Standalone-WASM stubs.
 *
 * SQLite only opens an in-memory database in this module. The unused POSIX
 * paths would otherwise pull a large WASI filesystem import set into the one
 * browser/WasmEdge artifact. The browser WASI shim deliberately has no
 * preopened filesystem, so these fail-closed stubs keep the import contract to
 * stdin/stdout while returning NOTCAPABLE if an unreachable file path is used.
 */

#include <errno.h>
#include <stdint.h>

/* ------------------------------------------------------------------------- */
/* Legacy syscall names can still be referenced by SQLite platform code. */
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

/*
 * wasi-libc imports these through __wasi_* when its filesystem helpers are
 * linked. The command bridge needs fd_read/fd_write, but SGP4 never needs the
 * rest. Keep these definitions in the guest so the browser harness does not
 * have to pretend that it owns a filesystem.
 */
typedef unsigned short wasi_errno_t;
typedef unsigned int wasi_fd_t;
typedef unsigned long long wasi_filesize_t;
typedef long long wasi_filesize_signed_t;
typedef unsigned long long wasi_timestamp_t;

#define WASI_ERRNO_NOTCAPABLE 76u

wasi_errno_t __wasi_fd_close(wasi_fd_t fd) {
    (void)fd;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_fd_fdstat_get(wasi_fd_t fd, void* stat) {
    (void)fd; (void)stat;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_fd_fdstat_set_flags(wasi_fd_t fd, unsigned short flags) {
    (void)fd; (void)flags;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_fd_filestat_get(wasi_fd_t fd, void* stat) {
    (void)fd; (void)stat;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_fd_filestat_set_size(wasi_fd_t fd, wasi_filesize_t size) {
    (void)fd; (void)size;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_fd_prestat_get(wasi_fd_t fd, void* prestat) {
    (void)fd; (void)prestat;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_fd_prestat_dir_name(wasi_fd_t fd, char* path, unsigned int path_len) {
    (void)fd; (void)path; (void)path_len;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_fd_seek(wasi_fd_t fd, wasi_filesize_signed_t offset, unsigned char whence, wasi_filesize_t* new_offset) {
    (void)fd; (void)offset; (void)whence; (void)new_offset;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_path_create_directory(wasi_fd_t fd, const char* path, unsigned int path_len) {
    (void)fd; (void)path; (void)path_len;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_path_filestat_get(wasi_fd_t fd, unsigned int flags, const char* path, unsigned int path_len, void* stat) {
    (void)fd; (void)flags; (void)path; (void)path_len; (void)stat;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_path_filestat_set_times(wasi_fd_t fd, unsigned int flags, const char* path, unsigned int path_len, wasi_timestamp_t atim, wasi_timestamp_t mtim, unsigned short fst_flags) {
    (void)fd; (void)flags; (void)path; (void)path_len; (void)atim; (void)mtim; (void)fst_flags;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_path_open(wasi_fd_t fd, unsigned int dirflags, const char* path, unsigned int path_len, unsigned int oflags, unsigned long long rights_base, unsigned long long rights_inheriting, unsigned short fdflags, wasi_fd_t* opened_fd) {
    (void)fd; (void)dirflags; (void)path; (void)path_len; (void)oflags; (void)rights_base; (void)rights_inheriting; (void)fdflags; (void)opened_fd;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_path_readlink(wasi_fd_t fd, const char* path, unsigned int path_len, char* buffer, unsigned int buffer_len, unsigned int* used) {
    (void)fd; (void)path; (void)path_len; (void)buffer; (void)buffer_len; (void)used;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_path_remove_directory(wasi_fd_t fd, const char* path, unsigned int path_len) {
    (void)fd; (void)path; (void)path_len;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_path_unlink_file(wasi_fd_t fd, const char* path, unsigned int path_len) {
    (void)fd; (void)path; (void)path_len;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_poll_oneoff(const void* subscriptions, void* events, unsigned int count, unsigned int* out_count) {
    (void)subscriptions; (void)events; (void)count; (void)out_count;
    return WASI_ERRNO_NOTCAPABLE;
}
wasi_errno_t __wasi_sched_yield(void) {
    return WASI_ERRNO_NOTCAPABLE;
}
