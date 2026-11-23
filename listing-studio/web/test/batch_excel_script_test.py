import json
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path
from xml.etree import ElementTree as ET

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'write-batch-excel.py'
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def png(color):
    def chunk(name, data):
        crc = zlib.crc32(name + data)
        return struct.pack('!I', len(data)) + name + data + struct.pack('!I', crc)

    header = struct.pack('!IIBBBBB', 4, 4, 8, 2, 0, 0, 0)
    pixels = zlib.compress((b'\0' + bytes(color) * 4) * 4)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', pixels) + chunk(b'IEND', b'')


class WorkbookTest(unittest.TestCase):
    def run_export(self, output, records):
        return subprocess.run([sys.executable, SCRIPT, output], input=json.dumps(records), text=True, capture_output=True)

    def test_cells_contain_the_two_images_and_results_in_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp, '调研.xlsx')
            first, second = Path(tmp, 'first.png'), Path(tmp, 'second.png')
            first.write_bytes(png((255, 0, 0)))
            second.write_bytes(png((0, 255, 0)))
            records = [
                {'name': '系列/画面2.png', 'imagePath': str(first), 'result': {
                    'titles': [{'text': 'First & Full Title'}, {'text': 'Second Title'}],
                    'keywords': [{'term': 'frog decor', 'translationZh': '青蛙装饰'}, {'term': 'wall decor'}],
                    'competitors': [{'title': 'Competitor A'}, {'title': 'Competitor B'}],
                }},
                {'name': '=1+2.png', 'imagePath': str(second), 'result': {
                    'titles': [{'text': 'Next Design'}, {'text': 'Another Title'}],
                    'keywords': [{'term': 'flower wall art'}], 'competitors': [{'title': 'Competitor C'}],
                }},
            ]
            run = self.run_export(output, records)
            self.assertEqual(run.returncode, 0, run.stderr)
            with zipfile.ZipFile(output) as workbook:
                root = ET.fromstring(workbook.read('xl/worksheets/sheet1.xml'))
                cells = {element.attrib['r']: element for element in root.findall('.//s:c', NS)}
                strings = ET.fromstring(workbook.read('xl/sharedStrings.xml'))
                shared = [''.join(item.itertext()) for item in strings]
                def value(cell):
                    return shared[int(cells[cell].findtext('s:v', namespaces=NS))]
                self.assertEqual([value(c + '1') for c in 'ABCDEFG'], [
                    '照片', '图片名称', '第一段标题', '第二段标题', '流量词', '竞品标题1', '竞品标题2',
                ])
                self.assertEqual([value(c + '2') for c in 'BCDEFG'], [
                    '系列/画面2.png', 'First & Full Title', 'Second Title', 'frog decor, wall decor',
                    'Competitor A', 'Competitor B',
                ])
                self.assertEqual([value(c + '3') for c in 'BCDEF'], [
                    '=1+2.png', 'Next Design', 'Another Title', 'flower wall art', 'Competitor C',
                ])
                self.assertEqual(cells['B3'].get('t'), 's')
                self.assertIsNone(cells['B3'].find('s:f', NS))
                self.assertEqual([cells[address].get('vm') for address in ['A2', 'A3']], ['1', '2'])
                self.assertIn('xl/metadata.xml', workbook.namelist())
                media = [workbook.read(name) for name in workbook.namelist() if name.startswith('xl/media/')]
                self.assertEqual(media, [first.read_bytes(), second.read_bytes()])

    def test_export_failure_does_not_replace_existing_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp, '现有.xlsx')
            output.write_bytes(b'existing report')
            run = self.run_export(output, [{'name': '坏图.jpg', 'imagePath': str(Path(tmp, 'missing.jpg')), 'result': {
                'titles': [{'text': 'One'}, {'text': 'Two'}], 'keywords': [{'term': 'flower wall art'}],
                'competitors': [{'title': 'Competitor A'}],
            }}])
            self.assertNotEqual(run.returncode, 0)
            self.assertEqual(output.read_bytes(), b'existing report')
            self.assertEqual(list(Path(tmp).iterdir()), [output])


if __name__ == '__main__':
    unittest.main()
