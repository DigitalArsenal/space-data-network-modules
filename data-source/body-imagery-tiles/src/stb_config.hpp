// stb_image 2.30 for the reductions's JPEG decode (body-imagery/vendor, SHA-256 pinned by its build): JPEG only,
// no stdio, no SIMD, no thread locals, at most 16384 px a side.
#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_JPEG
#define STBI_NO_STDIO
#define STBI_NO_LINEAR
#define STBI_NO_HDR
#define STBI_NO_SIMD
#define STBI_NO_THREAD_LOCALS
#define STBI_MAX_DIMENSIONS 16384
