# Licensing Client/Server Flow

## Canonical split

- Server-hosted guest modules that need outbound libp2p streams use the hosted
  `protocol.request` bridge through `sdn-server`.
- Browser and client-side JS do **not** use guest-side `protocol.request` for
  live licensing or IPFS transport. Those flows are asynchronous and belong in
  `sdn-js` and other host-side JS helpers.

## Server path

- `space-data-network/sdn-server` now provisions `protocol_dial` for hosted
  WasmEdge modules.
- The `sdn_host` bridge advertises `protocol.request` only when that handler is
  actually registered.
- `space-data-network/sdn-server` now has a concrete protocol cap handler that
  dials a libp2p stream, writes request bytes, and returns the response bytes
  to the hosted guest.
- `packages/protection-license-client` is now declared as a hosted WasmEdge
  module for DEK retrieval over `protocol.request`.

## Browser/client path

- Use `space-data-network/sdn-js` for the async license challenge/proof/grant
  exchange on `/orbpro/license/1.0.0`.
- Use the browser-safe decrypt path (`packages/client-decrypt` and/or
  `space-data-network/packages/module-runner/src/artifact-crypto.js`) for local
  artifact decryption.
- Do not assume the browser `sdn_host` bridge can perform arbitrary async
  networking from inside a guest module. The current browser guest ABI is still
  synchronous.

## Why this split exists

- `sdn-server` can block a hosted guest on outbound network calls because the
  host runtime owns the execution thread.
- The browser `sdn_host` bridge is synchronous, while libp2p/IPFS browser
  operations are asynchronous. Forcing those through guest imports is the wrong
  boundary.

## Sibling repo changes applied

- `space-data-network/sdn-server`
  - Added the concrete `protocol.request` host implementation for hosted
    modules.
  - Registered the `protocol_dial` capability when the libp2p host is active.
  - Added server tests for protocol-cap dispatch, host operation exposure, and
    the challenge/proof/grant license flow.
- `space-data-network/sdn-js`
  - Added a client-side license flow test around the existing async relay
    exchange.
- `space-data-network/packages/module-runner`
  - Corrected the package docs/comments so libp2p is described as inbound
    protocol registration, not a general guest-side transport bridge.
  - Added a smoke test so `npm test` is real again.

## Verification

- `space-data-network/sdn-server`
  - `go test ./internal/license ./internal/modulert/caps ./internal/node/...`
- `space-data-network/sdn-js`
  - `npx vitest run src/license.test.ts src/license-flow.test.ts`
- `space-data-network/packages/module-runner`
  - `npm test`
- `space-data-network-plugins`
  - `node --test packages/protection-license-client/tests/sdk_compat.test.mjs`
  - `npm test` in `packages/plugin-delivery`
  - `npm test` in `packages/client-decrypt`
