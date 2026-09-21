"""Independent circular-orbit identities; J2000, km/km/s, arbitrary UTC epoch.
Tolerances of 1e-9 km and 1e-12 km/s cover floating-point roundoff only.
Synthetic rows are NOT provider data. These tests check column interpretation.
"""
import importlib.util
import math
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('audit-vimpel-epoch.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

class EpochTest(unittest.TestCase):
    def row(self, inc=0, node=0, u=0, w=0, e=0):
        return ['1','1','01012026','01012026 000000','0','7000',str(inc),str(node),str(e),str(u),str(w),'0','0','0','0']

    def close(self, actual, expected, tolerance):
        for a,b in zip(actual,expected):
            self.assertAlmostEqual(a,b,delta=tolerance)

    def test_circular_argument_of_latitude_not_mean_anomaly(self):
        r,v = audit.state(self.row(u=90,w=37))
        self.close(r,[0,7000,0],1e-9)
        self.close(v,[-math.sqrt(audit.MU/7000),0,0],1e-12)

    def test_polar_node_rotation(self):
        r,v = audit.state(self.row(inc=90,node=90,u=90))
        self.close(r,[0,0,7000],1e-9)
        self.close(v,[0,-math.sqrt(audit.MU/7000),0],1e-12)

    def test_eccentric_perigee_vis_viva(self):
        r,v = audit.state(self.row(e=.1))
        self.close(r,[6300,0,0],1e-9)
        self.close(v,[0,math.sqrt(audit.MU*(2/6300-1/7000)),0],1e-12)

    def test_native_leading_zeros_do_not_change_identity(self):
        self.assertEqual(audit.archive_key('ephem.20260907/010201_20260908_120000'),'10201_20260908_120000')

    def test_unbound_elements_rejected(self):
        for e in [-.1,1,1.1,float('nan')]:
            with self.assertRaises(ValueError):
                audit.state(self.row(e=e))
