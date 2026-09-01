# The OFF-FLEET pyramid builder's container: linux/amd64, Node for the flow
# host, and the PINNED WasmEdge for the engine cross-check.
#
# WHY BOTH. The compiled flow runtime executes in whatever engine the host
# process provides, and this host process is Node — so a container with only
# Node changes the CPU target and NOT the engine, and every $DTT byte it cuts is
# still V8's. `node:22-bookworm` was exactly that: `--docker` produced a
# reproducible build on a different architecture and left the engine question
# untouched. run.mjs re-cuts every cell under WasmEdge and compares byte for
# byte, so the image has to carry the runtime the fleet serves under.
#
# The version is INJECTED from the SDK's single pin
# (src/testing/wasmedgePin.json) — never written here, so the host pin and the
# container pin cannot drift apart.
FROM node:22-bookworm

ARG WASMEDGE_VERSION
RUN test -n "${WASMEDGE_VERSION}" || (echo "WASMEDGE_VERSION build-arg is required (injected from the SDK pin)" && exit 1)

RUN set -eux; \
    arch="$(uname -m)"; \
    case "${arch}" in \
      x86_64) triple="manylinux_2_28_x86_64" ;; \
      aarch64) triple="manylinux_2_28_aarch64" ;; \
      *) echo "unsupported architecture: ${arch}"; exit 1 ;; \
    esac; \
    curl -sSfL \
      "https://github.com/WasmEdge/WasmEdge/releases/download/${WASMEDGE_VERSION}/WasmEdge-${WASMEDGE_VERSION}-${triple}.tar.gz" \
      -o /tmp/wasmedge.tar.gz; \
    mkdir -p /opt/wasmedge; \
    tar -xzf /tmp/wasmedge.tar.gz -C /opt/wasmedge; \
    rm /tmp/wasmedge.tar.gz; \
    LD_LIBRARY_PATH=/opt/wasmedge/lib64:/opt/wasmedge/lib /opt/wasmedge/bin/wasmedge --version

ENV PATH="/opt/wasmedge/bin:${PATH}" \
    LD_LIBRARY_PATH="/opt/wasmedge/lib64:/opt/wasmedge/lib" \
    SDM_WASMEDGE_BINARY="/opt/wasmedge/bin/wasmedge"

WORKDIR /work
