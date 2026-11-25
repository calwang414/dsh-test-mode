"""Read raw OOXML cells without losing inline text, coordinates or sheets.

Copied into each leaf Skill that reads XLSX; it has no third-party dependencies.
Values are raw stored/cached strings, not rendered Excel date/number formats.
"""
from pathlib import Path
import posixpath
import re
import zipfile
from xml.etree import ElementTree as ET

_NS = {'a': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def _text(element):
    return ''.join(t.text or '' for t in element.findall('.//a:t', _NS))


def _column(reference):
    match = re.fullmatch(r'([A-Za-z]+)[1-9][0-9]*', reference)
    if not match:
        raise ValueError('Invalid cell coordinate: ' + reference)
    column = 0
    for char in match.group(1).upper():
        column = column * 26 + ord(char) - ord('A') + 1
    if column > 16384:
        raise ValueError('Cell column exceeds the XLSX grid')
    return column - 1


def _sheet_paths(archive):
    names = set(archive.namelist())
    if 'xl/workbook.xml' not in names:
        # Minimal legacy packages may omit workbook metadata. Keep every sheet.
        return [(Path(p).stem, p) for p in sorted(names) if re.fullmatch(r'xl/worksheets/sheet[0-9]+\.xml', p)]
    book = ET.fromstring(archive.read('xl/workbook.xml'))
    rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
    targets = {r.attrib['Id']: r for r in rels}
    result = []
    for sheet in book.findall('a:sheets/a:sheet', _NS):
        rel = targets[sheet.attrib['{' + _REL + '}id']]
        if rel.attrib.get('TargetMode') == 'External':
            raise ValueError('External worksheet references are not supported')
        target = rel.attrib['Target']
        path = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target))
        if not path.startswith('xl/') or path not in names:
            raise ValueError('Missing or invalid worksheet target: ' + path)
        result.append((sheet.attrib.get('name', Path(path).stem), path))
    return result


def read_workbook(path):
    sheets = []
    with zipfile.ZipFile(path) as archive:
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
            shared = [_text(si) for si in root.findall('a:si', _NS)]
        for name, member in _sheet_paths(archive):
            root = ET.fromstring(archive.read(member))
            rows, row_numbers, cell_types, formulas = [], [], {}, {}
            for row in root.findall('a:sheetData/a:row', _NS):
                cells = row.findall('a:c', _NS)
                coordinates = [c.attrib['r'] for c in cells if 'r' in c.attrib]
                inferred = int(re.search(r'[0-9]+$', coordinates[0]).group()) if coordinates and re.search(r'[0-9]+$', coordinates[0]) else (row_numbers[-1] + 1 if row_numbers else 1)
                number = int(row.attrib.get('r', inferred))
                if number < 1 or number > 1048576 or number in row_numbers:
                    raise ValueError('Invalid or duplicate row number')
                values, occupied = [], set()
                for cell in cells:
                    reference = cell.attrib.get('r')
                    index = _column(reference) if reference else len(values)
                    if reference and int(re.search(r'[0-9]+$', reference).group()) != number:
                        raise ValueError('Cell coordinate conflicts with its row: ' + reference)
                    if index in occupied:
                        raise ValueError('Duplicate cell coordinate')
                    occupied.add(index)
                    reference = reference or f'column-{index + 1}/row-{number}'
                    cell_type = cell.attrib.get('t', 'n')
                    cell_types[reference] = cell_type
                    value_node = cell.find('a:v', _NS)
                    formula = cell.find('a:f', _NS)
                    if formula is not None:
                        formulas[reference] = formula.text or ''
                    if cell_type == 'inlineStr':
                        value = _text(cell)
                    elif value_node is None or value_node.text is None:
                        if formula is not None:
                            raise ValueError('Formula has no cached value: ' + reference)
                        value = ''
                    elif cell_type == 's':
                        index_string = int(value_node.text)
                        if not 0 <= index_string < len(shared):
                            raise ValueError('Invalid shared-string reference: ' + reference)
                        value = shared[index_string]
                    else:
                        value = value_node.text
                    values.extend([''] * max(0, index + 1 - len(values)))
                    values[index] = value
                rows.append(values)
                row_numbers.append(number)
            sheets.append({'name': name, 'path': member, 'rows': rows,
                           'row_numbers': row_numbers, 'cell_types': cell_types, 'formulas': formulas})
    if not sheets:
        raise ValueError('No worksheets found')
    return sheets
