"""Host ABI tests, separate from authoritative numerical conformance tests.

The transport oracle is SDK src/invoke/codec.js plus ratified PIV/TAB bindings;
the pthread fixture is the same captured SOCRATES GP used by the module tests.
No expected orbital output is generated here.
"""
import ctypes as C
from hashlib import sha256
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import unittest
from unittest.mock import patch

from spacedatanetwork_astro.artifacts import get_artifact, list_artifacts
from spacedatanetwork_astro.runtime import (
    Frame, InvokeError, Module, RuntimeUnavailableError, WasmEdgeError,
    _API, _Value, _loadable_bytes, decode_response, encode_request, library_candidates,
)
from spacedatanetwork_astro.sds.PIV.PIV import PIV, PIVT
from spacedatanetwork_astro.sds.PIV.PIVResponse import PIVResponseT


class TransportTests(unittest.TestCase):
    def test_request_matches_generated_piv_reader_and_sdk_arena_alignment(self):
        frames = [Frame('first', b'abc', 'TIM.fbs', '$TIM', 'TIM'),
                  Frame('second', b'12345', 'FRM.fbs', '$FRM', 'FRM', alignment=32)]
        encoded = encode_request('convert_time', frames)
        root = PIV.GetRootAs(encoded)
        self.assertEqual(root.REQUEST().METHOD_ID(), b'convert_time')
        self.assertEqual(root.REQUEST().INPUTSLength(), 2)
        arena = root.REQUEST().PAYLOAD_ARENAAsNumpy()
        # NumPy's pointer is absolute in the Python bytes allocation; inspect
        # offset using generated FlatBuffers table rather than Python allocation.
        request_tab = root.REQUEST()._tab
        start = request_tab.Vector(request_tab.Offset(8))
        self.assertEqual(start % 32, 0)
        for index, frame in enumerate(frames):
            tab = root.REQUEST().INPUTS(index)
            self.assertEqual(bytes(arena[tab.OFFSET():tab.OFFSET() + tab.SIZE()]), frame.payload)
            self.assertEqual(tab.PORT_ID().decode(), frame.port_id)
            self.assertEqual(tab.TYPE_REF().SCHEMA_NAME().decode(), frame.schema_name)
            self.assertEqual(tab.TYPE_REF().ROOT_TYPE().decode(), frame.root_type)
            self.assertEqual((start + tab.OFFSET()) % tab.ALIGNMENT(), 0)

    def test_mapping_input_matches_frame(self):
        frame = Frame('request', b'payload', 'TIM.fbs', '$TIM', 'TIM')
        mapping = {'portId': 'request', 'payload': b'payload', 'typeRef': {
            'schemaName': 'TIM.fbs', 'fileIdentifier': '$TIM', 'rootTypeName': 'TIM'}}
        self.assertEqual(encode_request('convert_time', [frame]), encode_request('convert_time', [mapping]))

    def test_invalid_request_and_response_rejected(self):
        for method in ('', 42, None):
            with self.assertRaises(ValueError):
                encode_request(method, [])
        for alignment in (0, 3, 4, 65536):
            with self.assertRaises(ValueError):
                encode_request('a', [Frame('p', b'data', alignment=alignment)])
        for response in (b'', b'not a frame', b'\xff\xff\xff\xff$PIV', encode_request('a', [])):
            with self.assertRaises(WasmEdgeError):
                decode_response(response)

    def test_generated_module_error_is_not_silently_discarded(self):
        import flatbuffers
        b = flatbuffers.Builder(256)
        root = PIVT(RESPONSE=PIVResponseT(STATUS_CODE=42, STATUS=3,
                    ERROR_CODE='invalid-input', ERROR_MESSAGE='test rejection')).Pack(b)
        b.Finish(root, file_identifier=b'$PIV')
        with self.assertRaisesRegex(InvokeError, 'invalid-input: test rejection'):
            decode_response(bytes(b.Output()))

    def test_library_search_order_and_actionable_error(self):
        with patch.dict(os.environ, {'WASMEDGE_LIB': '/explicit/libwasmedge.so'}):
            self.assertEqual(next(library_candidates()), '/explicit/libwasmedge.so')
            with patch('spacedatanetwork_astro.runtime.C.CDLL', side_effect=OSError('not found')):
                with self.assertRaisesRegex(RuntimeUnavailableError, 'space-data-network/scripts/install-wasmedge.sh'):
                    _API()

    def test_publication_trailer_reduction_matches_pinned_payload(self):
        data = get_artifact('foundation/frames').read_bytes()
        reduced = _loadable_bytes(data)
        self.assertTrue(reduced.startswith(b'\0asm\1\0\0\0'))
        if data[-4:] == b'$REC':
            size = struct.unpack_from('<I', data, len(data) - 8)[0]
            self.assertEqual(reduced, data[:-8-size])
        with self.assertRaises(WasmEdgeError):
            _loadable_bytes(b'not wasm')


class NativeRuntimeTests(unittest.TestCase):
    def test_pinned_c_abi_value_roundtrip(self):
        api = _API()
        self.assertEqual(api.version, '0.16.4')
        self.assertEqual(C.sizeof(_Value), 32)
        for value in (-2147483648, -1, 0, 42, 2147483647):
            self.assertEqual(api.ValueGetI32(api.ValueGenI32(value)), value)

    def test_all_nine_artifacts_load_and_reject_unknown_method(self):
        for name in list_artifacts():
            with self.subTest(module=name), Module(name) as module:
                self.assertEqual(sha256(module.artifact_bytes).hexdigest(), get_artifact(name).sha256)
                self.assertGreater(module._call('plugin_get_manifest_flatbuffer_size'), 0)
                with self.assertRaises(InvokeError):
                    module.invoke('__python_unknown_method__')

    def test_allocations_freed_and_instance_can_recover_from_method_errors(self):
        with Module('time') as module:
            before = module._api.MemoryInstanceGetPageSize(module.memory)
            for _ in range(100):
                with self.assertRaises(InvokeError):
                    module.invoke('__python_unknown_method__')
            self.assertEqual(module._api.MemoryInstanceGetPageSize(module.memory), before)
        module.close()
        with self.assertRaisesRegex(WasmEdgeError, 'closed'):
            module.invoke('__python_unknown_method__')

    def test_isolated_vm_memory_and_bounds(self):
        with Module('time') as first, Module('time') as second:
            ptr1, ptr2 = first._call('plugin_alloc', (8,)), second._call('plugin_alloc', (8,))
            try:
                first._write(ptr1, b'firstone')
                second._write(ptr2, b'second!!')
                self.assertEqual(first._read(ptr1, 8), b'firstone')
                self.assertEqual(second._read(ptr2, 8), b'second!!')
                with self.assertRaisesRegex(WasmEdgeError, 'out of bounds'):
                    first._read(0xfffffff0, 32)
            finally:
                first._call('plugin_free', (ptr1, 8))
                second._call('plugin_free', (ptr2, 8))

    def test_real_conjunction_pthreads_over_shared_memory(self):
        # Bound the process so a thread-host regression cannot hang the suite.
        # This is a threading check, not a claim of numerical authority: it uses
        # the module's captured GP input and asserts actual native thread starts.
        fixture = Path(__file__).parent / 'fixtures/module-vectors.json'
        code = r'''
import json, sys
from spacedatanetwork_astro.runtime import Module, Frame
from spacedatanetwork_astro._codec import obj, pack, unpack
records = json.load(open(sys.argv[1]))['conjunctionGp']['gp_61721,67298.json']
gps = [obj('orbpro.conjunction.GpRecord', local=True, **{
    k.split('_')[0].lower() + ''.join(w.title() for w in k.split('_')[1:]): v
    for k, v in record.items()}) for record in records]
request = obj('orbpro.conjunction.ConjunctionScreenCatalogRequest', local=True,
    primaryGps=gps, numThreads=2, startJd=2461108., durationDays=1./86400.,
    coarseStepSec=1., thresholdKm=100000., usePerigeeFilter=False)
with Module('conjunction-assessment') as module:
    frames = module.invoke('screen_catalog', [Frame('request', pack(request, 'CASQ'),
        'orbpro.conjunction.ConjunctionScreenCatalogRequest', 'CASQ',
        'ConjunctionScreenCatalogRequest')])
    assert len(frames) == 1
    result = unpack('orbpro.conjunction.ConjunctionScreenCatalogResult', frames[0].payload, local=True)
    assert module.spawned_threads >= 2, module.spawned_threads
    assert not module._thread_errors, module._thread_errors
    print('Native conjunction guest threads:', module.spawned_threads)
'''
        result = subprocess.run([sys.executable, '-c', code, str(fixture)], text=True,
                                capture_output=True, timeout=25)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Native conjunction guest threads:', result.stdout)


if __name__ == '__main__':
    unittest.main()
