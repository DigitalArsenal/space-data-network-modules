;; The nine Emscripten imports of the US Space Force Sgp4Prop build, answered in WebAssembly, and the two
;; copies between this module's memory and the Space Force module's memory.
;;
;; The Space Force build (third_party/ussf-sgp4/Sgp4Prop.xp.wasm) is an Emscripten output: it imports nine
;; functions from the module "a" (the names are minified) that Emscripten's JavaScript runtime supplies, and
;; it keeps its own linear memory. build.mjs joins three modules with binaryen's wasm-merge:
;;
;;   adapter   the SDN module, compiled by the SDK; its memory is memory 0 and the one the hosts see
;;   ussf      the Space Force build, as released; its memory becomes memory 1
;;   a         this file; it answers the Space Force build's imports from module "a"
;;
;; Nothing here is physics. The Space Force code only reaches these functions to write log lines, to read
;; files it is never asked to read, and to grow its heap; this module has no files and discards the log.
;;
;;   import      Emscripten function          answer
;;   a.a         fd_close(fd)                 0, success
;;   a.b         fd_write(fd, iov, n, pnum)   the byte count of the vectors, written to *pnum; the bytes are dropped
;;   a.c         __syscall_fcntl64(...)       0
;;   a.d         emscripten_resize_heap(req)  grow the Space Force memory to hold req bytes: 1, or 0 past 2 GiB
;;   a.e         fd_seek(fd, off, whence, p)  70, ESPIPE
;;   a.f         fd_read(fd, iov, n, pnum)    0 bytes, end of input
;;   a.g         __syscall_ioctl(...)         -59, ENOTTY
;;   a.h         __syscall_openat(...)        -44, ENOENT
;;   a.i         emscripten_memcpy_big(d,s,n) memory.copy inside the Space Force memory
;;
;; The copies the SDN code uses to move bytes in and out of the Space Force memory:
;;   put(dst, src, n)   Space Force memory [dst, dst+n)  <-  this module's memory [src, src+n)
;;   get(dst, src, n)   this module's memory [dst, dst+n) <-  Space Force memory [src, src+n)
;;   pages()            the Space Force memory's size in 64 KiB pages
;;   zero(dst, n)       Space Force memory [dst, dst+n) <- zeros
;; put, get, pages and zero are what ussf.hpp's Library::recycle needs: the library does not give back the memory of
;; an SGP4-XP satellite it has propagated (about 29 KB each, however the satellite is removed), so the SDN code
;; restores the library's memory to the state it had when the library was ready.
(module
  (import "ussf" "j" (memory $u 0))
  (import "adapter" "memory" (memory $m 1 32768 shared))

  (func (export "put") (param $dst i32) (param $src i32) (param $n i32)
    (memory.copy $u $m (local.get $dst) (local.get $src) (local.get $n)))

  (func (export "get") (param $dst i32) (param $src i32) (param $n i32)
    (memory.copy $m $u (local.get $dst) (local.get $src) (local.get $n)))

  (func (export "pages") (result i32)
    (memory.size $u))

  (func (export "zero") (param $dst i32) (param $n i32)
    (memory.fill $u (local.get $dst) (i32.const 0) (local.get $n)))

  (func (export "a") (param $fd i32) (result i32)
    (i32.const 0))

  (func (export "b") (param $fd i32) (param $iov i32) (param $count i32) (param $pnum i32) (result i32)
    (local $i i32) (local $bytes i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
        (local.set $bytes
          (i32.add (local.get $bytes)
            (i32.load $u offset=4 (i32.add (local.get $iov) (i32.shl (local.get $i) (i32.const 3))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (i32.store $u (local.get $pnum) (local.get $bytes))
    (i32.const 0))

  (func (export "c") (param i32 i32 i32) (result i32)
    (i32.const 0))

  (func (export "d") (param $requested i32) (result i32)
    (local $have i32) (local $need i64)
    (local.set $have (memory.size $u))
    (local.set $need
      (i64.shr_u (i64.add (i64.extend_i32_u (local.get $requested)) (i64.const 65535)) (i64.const 16)))
    (if (i64.gt_u (local.get $need) (i64.const 32768)) (then (return (i32.const 0))))
    (if (i64.le_u (local.get $need) (i64.extend_i32_u (local.get $have))) (then (return (i32.const 1))))
    (i32.ne
      (memory.grow $u (i32.wrap_i64 (i64.sub (local.get $need) (i64.extend_i32_u (local.get $have)))))
      (i32.const -1)))

  (func (export "e") (param i32 i64 i32 i32) (result i32)
    (i32.const 70))

  (func (export "f") (param $fd i32) (param $iov i32) (param $count i32) (param $pnum i32) (result i32)
    (i32.store $u (local.get $pnum) (i32.const 0))
    (i32.const 0))

  (func (export "g") (param i32 i32 i32) (result i32)
    (i32.const -59))

  (func (export "h") (param i32 i32 i32 i32) (result i32)
    (i32.const -44))

  (func (export "i") (param $dst i32) (param $src i32) (param $n i32)
    (memory.copy $u $u (local.get $dst) (local.get $src) (local.get $n))))
