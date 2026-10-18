// GAIA DR3 OVER SDN, END TO END (gaia-octree-retrieval-20261016).
//
// A local provider node (SDN_NODE_BINARY, built from sdn main at or after
// 90e522de0) runs the Gaia flow once against ESA's archive through a caching
// TAP proxy (GAIA_TAP_CACHE; offline after the first fill). Then, as a
// consumer finds them over SDN (list_published_shards, $DPM, shards):
//  - both $SKT layers are listed (gaia-dr3 angular-g13.5 and octree-g13.5);
//  - the octree's invariants hold over every node: each node's faintest star
//    is no fainter than any child's brightest, every star is in exactly one
//    node, every point lies inside its node's cube (so its float32 offset is
//    exact to 2^-25 of the node's edge, well inside 1e-7), CHILD_MASK names
//    exactly the children published, and the keys and centers agree;
//  - 20 SIMBAD-named stars (tests/fixtures/simbad-named-stars.json): the
//    module's cone_rows at SIMBAD's J2000 place, radius 1 mas, epoch J2000,
//    returns the star, and its distance is within 1 sigma of CDS VizieR's
//    Bailer-Jones 2021 distance (I/352, a second channel to the catalog);
//  - the s2a field's 41 cones (tests/fixtures/s2a-cones.json.gz: ESA's own
//    answers, re-asked at the centers and radii the field study's cached
//    answers are named by, which round them to 0.001 and 0.01 deg):
//    cone_tiles then cone_rows on the angular layer return ESA's Gaia source
//    ids, but for stars within 5" of a cone's edge (ESA's CONTAINS is
//    approximate there);
//  - CDS's Gaia DR3 HiPS catalog (I/355/gaiadr3) gives the same stars for two
//    of the run's order-4 tiles (HiPS Norder 4, Npix = the tile's PIXEL);
//  - the node's peak resident memory, sampled by its PID, is logged and at
//    most 2 GB.
// The sky is the order-3 pixels the cones and the named stars touch (the
// module's cone_tiles says which); GAIA_OCTREE_FULL_SKY=1 runs all 768.
//
// env: SDN_NODE_BINARY (required), STACK_ROOT (deployment/solar-system-provider-node/sign-flow.mjs),
//      SDN_JS (sdn-js with dist/), GAIA_TAP_CACHE, GAIA_TAP_OFFLINE=1, GAIA_OCTREE_FULL_SKY=1.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';
import {startTapProxy} from './lib/tap-proxy.mjs';
import {createProviderNode, waitFor, PROGRAM} from './lib/provider-node.mjs';
import {openLanes, sizePrefixed} from './lib/sdn-lanes.mjs';
import {hipsCatalog} from './lib/hips.mjs';
import {cones, skyPixels, coneHarness, readTile, readRow, sktPartitionScheme} from './lib/records.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const STACK = process.env.STACK_ROOT || path.join(os.homedir(), 'software/spacedatanetwork-stack');
const SDN_JS = process.env.SDN_JS || path.join(STACK, 'repos/main-packages/space-data-network/sdn-js');
const BINARY = process.env.SDN_NODE_BINARY;
const CACHE = process.env.GAIA_TAP_CACHE || path.join(os.homedir(), '.cache/gaia-octree-tap');
const FULL = process.env.GAIA_OCTREE_FULL_SKY === '1';
const RSS_LIMIT_KIB = 2 * 1024 * 1024;
const J2000 = 2451545.0;
const s2a = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(PKG, 'tests/fixtures/s2a-cones.json.gz'))));
const named = JSON.parse(fs.readFileSync(path.join(PKG, 'tests/fixtures/simbad-named-stars.json'), 'utf8')).stars;
const log = (s) => console.log(`# ${s}`);

test('Gaia DR3 over SDN: both layers from a local provider node', {timeout: 6 * 3600_000}, async () => {
  assert.ok(BINARY && fs.existsSync(BINARY), 'set SDN_NODE_BINARY (an sdn binary from sdn main at or after 90e522de0)');
  if (!fs.existsSync(path.join(PKG, 'dist/flow/runtime/runtime.wasm'))) {
    assert.equal(spawnSync(process.execPath, ['build.mjs'], {cwd: PKG, stdio: 'inherit'}).status, 0, 'build.mjs');
  }
  const cone = await coneHarness(PKG);
  const proxy = await startTapProxy({upstream: 'https://gea.esac.esa.int/tap-server/tap', cacheDir: CACHE, offline: process.env.GAIA_TAP_OFFLINE === '1'});
  const node = await createProviderNode({binary: BINARY, stackRoot: STACK, packageDir: PKG});
  let lanes;
  try {
    // The sky: every order-3 pixel a cone or a named star touches.
    const s2aQuery = s2a.cones.map((c) => ({ra: c.ra, dec: c.dec, radius: c.radius}));
    const namedQuery = named.map((s) => ({ra: s.ra_deg_j2000, dec: s.dec_deg_j2000, radius: 1 / 3.6e6, jd: J2000}));
    const sky = FULL ? [] : (await cone.tiles(cones([...s2aQuery, ...namedQuery]), skyPixels(3))).map((b) => Number(readTile(b).PIXEL()));
    log(`sky: ${FULL ? 'all 768' : `${sky.length} order-3 pixels (${sky.join(',')})`}`);

    const {peerId, ws} = await node.start();
    const capabilities = await node.install({gaia_octree_enabled: true, gaia_octree_producer_peer_id: peerId, gaia_octree_tap_url: proxy.url,
      gaia_octree_g_limit: 13.5, ...(FULL ? {} : {gaia_octree_sky: sky})});
    log(`${PROGRAM} signed by the node, ${capabilities.join(', ')} approved, installed`);
    const t0 = Date.now();
    await node.start();
    lanes = await openLanes({sdnJs: SDN_JS, provider: peerId, addrs: [ws]});
    const lane = (sourceName) => ({schema: 'SKT.fbs', providerId: 'gaia-dr3', sourceName});
    const ended = new RegExp(`Retrieval attempt failed for ${PROGRAM.replace(/\./g, '\\.')}.*`);
    const octree = await waitFor('the octree layer on SDN', async () => {
      const failed = node.log().match(ended);
      if (failed) return {failed: failed[0].slice(0, 600)};
      return lanes.records(lane('octree-g13.5'));
    }, FULL ? 5 * 3600_000 : 3600_000, node.child, 10_000);
    assert.ok(!octree.failed, `the flow's cycle failed: ${octree.failed}; TAP proxy: ${JSON.stringify(proxy.stats)}`);
    const angular = await lanes.records(lane('angular-g13.5'));
    assert.ok(angular, 'the angular layer is listed');
    log(`the flow's cycle published both layers in ${((Date.now() - t0) / 1000).toFixed(0)} s (TAP: ${proxy.stats.misses} fetched, ${proxy.stats.hits} cached)`);
    log(`node peak RSS ${(node.rss.peakKiB / 1024).toFixed(0)} MiB over ${node.rss.samples} samples`);

    // ── the angular layer ──
    const tiles = angular.records.map((b) => ({bytes: b, t: readTile(b)}));
    const wantTiles = FULL ? 3072 : sky.length * 4;
    assert.equal(tiles.length, wantTiles, 'one tile per order-4 pixel of the sky');
    const angularStars = tiles.reduce((n, {t}) => n + t.POINT_COUNT(), 0);
    for (const {t} of tiles) {
      assert.equal(t.PARTITION(), sktPartitionScheme.HEALPIX);
      assert.equal(t.ORDER(), 4);
    }
    log(`angular-g13.5: ${tiles.length} tiles, ${angularStars} stars (${angular.shards} shard(s), batch ${angular.batch})`);
    const rowsOf = new Map();
    const tileRows = async (t) => {
      const cid = t.ROW_COLLECTION_CID();
      if (!cid) return new Uint8Array(0);
      if (!rowsOf.has(cid)) rowsOf.set(cid, await lanes.fetchCid(cid, 128 << 20));
      return rowsOf.get(cid);
    };
    const tileStream = Buffer.concat(tiles.map(({bytes}) => Buffer.from(bytes)));

    // s2a: ESA's own answers (Gaia ids only; Hipparcos-only rows have none).
    let s2aIds = 0, edge = 0;
    for (const c of s2a.cones) {
      const q = cones([{ra: c.ra, dec: c.dec, radius: c.radius, magLimit: 13.5}]);
      const touched = await cone.tiles(q, tileStream);
      const rows = await cone.rows(q, await Promise.all(touched.map((b) => tileRows(readTile(b)))));
      const gaiaIds = (list) => list.map(readRow).map((r) => r.GAIA_DR3_SOURCE_ID()).filter((id) => id > 0n).map(String);
      const ids = new Set(gaiaIds(rows)), esa = new Set(c.ids);
      const differ = [...ids].filter((id) => !esa.has(id)).concat(c.ids.filter((id) => !ids.has(id)));
      if (differ.length) {
        // ESA's CONTAINS is approximate at the circle's edge (a star ESA's own DISTANCE puts 2.6" inside one
        // was left out): a difference is admitted only for a star within 5" of the edge, which the module
        // decides (inside the cone 5" wider, outside the cone 5" narrower).
        const ring = async (radius) => new Set(gaiaIds(await cone.rows(cones([{ra: c.ra, dec: c.dec, radius, magLimit: 13.5}]),
          await Promise.all((await cone.tiles(cones([{ra: c.ra, dec: c.dec, radius}]), tileStream)).map((b) => tileRows(readTile(b)))))));
        const outer = await ring(c.radius + 5 / 3600), inner = await ring(c.radius - 5 / 3600);
        const offEdge = differ.filter((id) => !(outer.has(id) && !inner.has(id)));
        assert.deepEqual(offEdge, [], `cone (${c.ra}, ${c.dec}, ${c.radius}): the same source ids as ESA but for edge stars`);
        edge += differ.length;
      }
      s2aIds += ids.size;
    }
    log(`s2a: ${s2a.cones.length} cones, ${s2aIds} source ids, each set ESA's but for ${edge} star(s) within 5" of a cone's edge`);

    // CDS's Gaia DR3 HiPS catalog: our order-4 tiles are HiPS Norder 4 / Npix (NESTED, equatorial); the two
    // smallest non-empty tiles of the run against the same pixels' sources to G 13.5.
    const hips = hipsCatalog(path.join(CACHE, 'hips-gaiadr3'), {offline: process.env.GAIA_TAP_OFFLINE === '1'});
    const small = tiles.filter(({t}) => t.POINT_COUNT() > 0).sort((a, b) => a.t.POINT_COUNT() - b.t.POINT_COUNT()).slice(0, 2);
    for (const {t} of small) {
      const ours = new Set(sizePrefixed(await tileRows(t)).map(readRow).map((r) => r.GAIA_DR3_SOURCE_ID()).filter((id) => id > 0n).map(String));
      const theirs = await hips.pixelSources(4, Number(t.PIXEL()), 13.5);
      const both = [...ours].filter((id) => theirs.has(id)).length;
      const onlyOurs = ours.size - both, onlyTheirs = theirs.size - both;
      log(`HiPS Norder4/Npix${t.PIXEL()}: ours ${ours.size}, CDS ${theirs.size}, both ${both}, only ours ${onlyOurs}, only CDS ${onlyTheirs}`);
      assert.ok(onlyOurs + onlyTheirs <= Math.max(2, Math.ceil(0.002 * ours.size)), `HiPS Npix${t.PIXEL()}: the same stars, but for pixel-edge movers`);
    }
    log(`HiPS: ${hips.fetched} CDS tiles fetched this run`);

    // SIMBAD: position at J2000 within 1 mas, distance within the parallax 1 sigma.
    for (const s of named) {
      const q = cones([{ra: s.ra_deg_j2000, dec: s.dec_deg_j2000, radius: 1 / 3.6e6, jd: J2000}]);
      const touched = await cone.tiles(q, tileStream);
      const rows = (await cone.rows(q, await Promise.all(touched.map((b) => tileRows(readTile(b)))))).map(readRow);
      const row = rows.find((r) => String(r.GAIA_DR3_SOURCE_ID()) === s.gaia_dr3_source_id);
      assert.ok(row, `${s.name}: within 1 mas of SIMBAD's J2000 place`);
      const bj = s.bj2021_cds, photo = bj.rpgeo != null;
      const d0 = photo ? bj.rpgeo : bj.rgeo, sigma = photo ? (bj.B_rpgeo - bj.b_rpgeo) / 2 : (bj.B_rgeo - bj.b_rgeo) / 2;
      const d = row.DISTANCE_PC();
      assert.ok(Math.abs(d - d0) <= sigma, `${s.name}: ${d.toFixed(2)} pc vs CDS Bailer-Jones 2021 ${d0.toFixed(2)} +/- ${sigma.toFixed(2)} pc`);
    }
    log(`SIMBAD: ${named.length} named stars within 1 mas of SIMBAD at J2000, and within 1 sigma of CDS's Bailer-Jones 2021 distance`);

    // ── the octree ──
    const nodes = octree.records.map((b) => readTile(b));
    const byKey = new Map(nodes.map((n) => [`${n.OCTREE_LEVEL()}:${n.OCTREE_KEY()}`, n]));
    assert.equal(byKey.size, nodes.length, 'each (level, key) once');
    const seen = new Set();
    let points = 0;
    for (const n of nodes) {
      assert.equal(n.PARTITION(), sktPartitionScheme.OCTREE_HELIO_ICRS);
      const level = n.OCTREE_LEVEL(), key = n.OCTREE_KEY(), half = n.HALF_SIZE_PC();
      assert.ok(n.ABS_MAG_BRIGHTEST() <= n.ABS_MAG_FAINTEST());
      for (let c = 0; c < 8; c++) {
        const child = byKey.get(`${level + 1}:${key * 8n + BigInt(c)}`);
        assert.equal(Boolean(child), Boolean(n.CHILD_MASK() & (1 << c)), `node ${level}:${key} CHILD_MASK bit ${c}`);
        if (!child) continue;
        assert.ok(n.ABS_MAG_FAINTEST() <= child.ABS_MAG_BRIGHTEST(), `node ${level}:${key} is brighter than child ${c}`);
        assert.equal(child.HALF_SIZE_PC(), half / 2);
        for (const [axis, bit] of [['CENTER_X_PC', 1], ['CENTER_Y_PC', 2], ['CENTER_Z_PC', 4]]) assert.equal(child[axis](), n[axis]() + (c & bit ? half / 2 : -half / 2));
      }
      const payload = await lanes.fetchCid(n.PAYLOAD_CID(), 64 << 20);
      assert.equal(payload.length, n.POINT_COUNT() * 24);
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      let previous = -Infinity;
      for (let i = 0; i < n.POINT_COUNT(); i++) {
        for (let a = 0; a < 3; a++) assert.ok(Math.abs(view.getFloat32(i * 24 + 4 * a, true)) <= half, 'inside its cube');
        const abs = view.getInt16(i * 24 + 12, true);
        assert.ok(abs >= previous, 'brightest first');
        previous = abs;
      }
      for (const r of sizePrefixed(await lanes.fetchCid(n.ROW_COLLECTION_CID(), 64 << 20))) {
        const id = readRow(r).ID();
        assert.ok(!seen.has(id), `${id} is in one node`);
        seen.add(id);
      }
      points += n.POINT_COUNT();
    }
    assert.equal(seen.size, points);
    const depth = Math.max(...nodes.map((n) => n.OCTREE_LEVEL()));
    log(`octree-g13.5: ${nodes.length} nodes, ${points} stars, depth ${depth}; invariants hold`);
    const levels = {};
    for (const n of nodes) { const l = (levels[n.OCTREE_LEVEL()] ??= {nodes: 0, stars: 0}); l.nodes += 1; l.stars += n.POINT_COUNT(); }
    log(`octree-g13.5 per level: ${JSON.stringify(levels)}`);

    log(`ingest peak RSS ${(node.rss.peakKiB / 1048576).toFixed(2)} GiB (limit 2 GiB); macOS peak physical footprint ${node.footprintPeak() ?? 'n/a'}`);
    assert.ok(node.rss.peakKiB > 0 && node.rss.peakKiB <= RSS_LIMIT_KIB, `peak RSS ${node.rss.peakKiB} KiB`);
  } catch (error) {
    log(`FAIL ${String(error?.message ?? error).split('\n').slice(0, 12).join('\n# ')}`);
    throw error;
  } finally {
    await lanes?.close().catch(() => {});
    await node.stop().catch(() => {});
    await proxy.close();
    await cone.destroy();
  }
  node.remove();
});
// libp2p's handles can outlive the test; the verdict is reported by then.
after(() => setTimeout(() => process.exit(), 5000));
