"""Transport, catalog identity and NumPy marshalling boundary checks."""
import json
from pathlib import Path
import numpy as np
import pytest
import spacedatanetwork_astro as astro
from spacedatanetwork_astro._codec import pack, unpack
from spacedatanetwork_astro.runtime import frame_stream, unframe_stream


def test_size_prefixed_frames_and_truncation():
    assert frame_stream([b'abc',b'd']) == b'\x03\0\0\0abc\x01\0\0\0d'
    assert unframe_stream(frame_stream([b'abc',b'd'])) == [b'abc',b'd']
    for data in [b'\x03',b'\x03\0\0\0ab']:
        with pytest.raises(ValueError):unframe_stream(data)


def test_sgp4_omm_replacement_keeps_handle():
    from test_numerical import omm_record
    fixture=json.loads((Path(__file__).parent/'fixtures/module-vectors.json').read_text())['sgp4']
    record=omm_record(fixture['VALLADO_OMM'])
    with astro.SGP4() as catalog:
        assert catalog.ingest(record)==0
        assert catalog.ingest(record)==0
        assert catalog.count==1
        assert len(catalog.propagate(fixture['VALLADO_TARGET_JD']))==1


def test_numpy_propagator_samples_marshal_without_physics():
    states=np.arange(12,dtype=np.float64).reshape(2,6)
    stms=np.stack([np.eye(6),np.eye(6)])
    value=astro.estimation_samples([2451545.,2451546.],states,stms)
    decoded=unpack('orbpro.estimation.EstimationEnvelope',pack(value,'$EST'),local=True)
    np.testing.assert_array_equal(decoded.propagatorSamples[1].state,states[1])
    np.testing.assert_array_equal(decoded.propagatorSamples[0].stm,stms[0].ravel())
    track=astro.conjunction_track([2451545.,2451546.],states,norad_id=5)
    assert track.samples[1].vzKmS==states[1,5]
    with pytest.raises(ValueError):astro.estimation_samples([2451545.],states,stms)


def test_close_serializes_with_invoke_lock():
    import threading
    from unittest.mock import Mock
    from spacedatanetwork_astro.runtime import Module
    # Deliberately block destruction with an active invoke lock, without putting
    # native code at risk. A second closer must remain idempotent as well.
    module=Module.__new__(Module)
    module._invoke_lock=threading.RLock()
    module._closed=False
    module._threads=[]
    module._callbacks=[]
    delete=Mock()
    module._resources=[(123,delete)]
    entered=threading.Event()
    def close():
        entered.set()
        module.close()
    with module._invoke_lock:
        worker=threading.Thread(target=close)
        worker.start()
        assert entered.wait(1)
        worker.join(.02)
        assert worker.is_alive()
        delete.assert_not_called()
    worker.join(1)
    assert not worker.is_alive()
    module.close()
    delete.assert_called_once_with(123)


def test_large_tab_alignment_preserved_inside_guest():
    from unittest.mock import patch
    from spacedatanetwork_astro.runtime import Module, Frame, InvokeError
    from spacedatanetwork_astro.sds.PIV.PIV import PIV
    with Module('time') as module:
        original=module._write
        seen=[]
        def capture(offset,data,memory=None):
            if len(data)>8 and data[4:8]==b'$PIV':
                request=PIV.GetRootAs(data).REQUEST()
                arena=request._tab.Vector(request._tab.Offset(8))
                tab=request.INPUTS(0)
                seen.append((offset+arena+tab.OFFSET())%32768)
            original(offset,data,memory)
        with patch.object(module,'_write',side_effect=capture):
            with pytest.raises(InvokeError):
                module.invoke('__unknown__',[Frame('request',b'data',alignment=32768)])
        assert seen==[0]
