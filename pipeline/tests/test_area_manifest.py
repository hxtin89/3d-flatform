from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PIPELINE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PIPELINE))
import area_manifest as manifest


class LegacyManifestTests(unittest.TestCase):
    def test_existing_reports_do_not_load_scientific_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / 'local-storage/tilesets/survey-chunked-copc/chunks/a/conversion-report.json'
            report.parent.mkdir(parents=True)
            report.write_text('{"source_point_count": 12}')
            args = argparse.Namespace(dataset='survey', public_root='')
            with patch.dict(sys.modules, {'numpy': None, 'laspy': None, 'pyproj': None}):
                self.assertEqual(manifest.chunk_reports(root, args)[0][2]['source_point_count'], 12)

    def test_missing_inputs_have_actionable_error_without_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(sys.modules, {'numpy': None, 'laspy': None}):
                with self.assertRaisesRegex(SystemExit, 'APH fallback requires COPC chunks'):
                    manifest.chunk_reports(Path(directory), argparse.Namespace(dataset='survey', public_root=''))


@unittest.skipUnless(all(importlib.util.find_spec(m) for m in ['numpy', 'laspy', 'pyproj']), 'requires pipeline environment')
class AphHeaderManifestTests(unittest.TestCase):
    def setUp(self):
        import numpy as np
        import laspy
        from pyproj import CRS
        from build_adaptive_point_hierarchy import build_enu_frame
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.args = argparse.Namespace(dataset='survey', public_root='published-survey')
        self.crs = CRS.from_epsg(32719)
        self.files = []
        for index in range(2):
            path = self.root / f'local-storage/intermediate/survey/chunks-copc/chunk-{index}.copc.laz'
            path.parent.mkdir(parents=True, exist_ok=True)
            header = laspy.LasHeader(point_format=6, version='1.4')
            header.add_crs(self.crs)
            data = laspy.LasData(header)
            data.x = [500000 + index * 100, 500010 + index * 100]
            data.y = [8500000, 8500010]
            data.z = [150, 175]
            # Only the standard LAS header is used by this fallback, never COPC
            # hierarchy or points. An uncompressed fixture needs no LAZ codec.
            with path.open('wb') as stream:
                data.write(stream, do_compress=False)
            self.files.append(path)
        self.frame = build_enu_frame(self.crs, np.array([500000, 8500000, 150]))
        self.state = {
            'enuOriginSource': [500000, 8500000, 150],
            'rootTransform': self.frame['root_transform'],
            'enuOriginLonLat': self.frame['enu_origin_lonlat'],
            'enuOriginEcef': self.frame['enu_origin_ecef'].tolist(),
            'sourceFiles': [{'name': p.name, 'size': p.stat().st_size} for p in self.files],
            'totalSourcePoints': 4,
        }
        self.state_path = self.root / 'local-storage/tilesets/published-survey/published-survey-adaptive-point-hierarchy/.adaptive-point-hierarchy-state.json'
        self.state_path.parent.mkdir(parents=True)
        self.save_state()

    def save_state(self):
        self.state_path.write_text(json.dumps(self.state))

    def read(self):
        return manifest.chunk_reports(self.root, self.args)

    def test_reads_only_headers_with_published_namespace(self):
        from laspy import LasReader
        with patch.object(LasReader, 'read', side_effect=AssertionError('must not decode points')):
            records = self.read()
        self.assertEqual([r[0] for r in records], ['chunk-0', 'chunk-1'])
        self.assertEqual(sum(r[2]['source_point_count'] for r in records), 4)
        self.assertEqual(records[0][2]['root_transform'], self.state['rootTransform'])
        self.assertAlmostEqual(records[0][2]['root_bbox_enu']['mins'][0], 0, places=3)
        self.assertGreater(records[1][2]['root_bbox_enu']['mins'][0], 90)

    def test_rejects_missing_chunk(self):
        self.files[1].unlink()
        with self.assertRaisesRegex(SystemExit, 'source files do not match'):
            self.read()

    def test_rejects_changed_source_size(self):
        self.state['sourceFiles'][0]['size'] += 1
        self.save_state()
        with self.assertRaisesRegex(SystemExit, 'source size changed'):
            self.read()

    def test_rejects_wrong_root_transform(self):
        self.state['rootTransform'][12] += 10
        self.save_state()
        with self.assertRaisesRegex(SystemExit, 'does not reproduce'):
            self.read()

    def test_rejects_wrong_point_total(self):
        self.state['totalSourcePoints'] = 99
        self.save_state()
        with self.assertRaisesRegex(SystemExit, 'point total does not match'):
            self.read()


if __name__ == '__main__':
    unittest.main()
