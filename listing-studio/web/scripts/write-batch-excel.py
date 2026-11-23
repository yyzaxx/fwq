import json
import os
import sys
import tempfile
from pathlib import Path

# 内嵌单元格图片需要 XlsxWriter 3.2.9；固定私有依赖，避免系统旧版静默降级。
sys.path.insert(0, str(Path(__file__).resolve().parent / 'vendor'))
from xlsxwriter import Workbook


EXCEL_MAX_COLUMNS = 16384
HEADERS = ['照片', '图片名称', '第一段标题', '第二段标题', '流量词']


def unpack_row(record):
    result = record['result']
    titles = [title['text'] for title in result['titles']]
    terms = [keyword['term'] for keyword in result['keywords']]
    competitors = [competitor['title'] for competitor in result['competitors']]
    if len(titles) != 2 or not all(titles) or not terms or not competitors:
        raise ValueError('每张图片都必须有两段标题、流量词和竞品标题')
    return [record['name'], *titles, ', '.join(terms), *competitors]


def create_workbook(destination, records):
    if not isinstance(records, list) or not 1 <= len(records) <= 100:
        raise ValueError('每份批次 Excel 必须包含 1 至 100 张图片')
    rows = [unpack_row(record) for record in records]
    column_count = 1 + max(map(len, rows))
    if column_count > EXCEL_MAX_COLUMNS:
        raise ValueError('竞品标题数量超过 Excel 列数上限')
    headers = HEADERS + [f'竞品标题{index + 1}' for index in range(column_count - len(HEADERS))]
    handle, temporary = tempfile.mkstemp(prefix='.batch-excel-', suffix='.xlsx', dir=destination.parent)
    os.close(handle)
    try:
        with Workbook(temporary) as book:
            sheet = book.add_worksheet('批量调研')
            head = book.add_format({'bold': True, 'bg_color': '#213B5C', 'font_color': '#FFFFFF', 'valign': 'vcenter'})
            cell = book.add_format({'text_wrap': True, 'valign': 'vcenter', 'bottom': 1, 'bottom_color': '#E1E7EF'})
            sheet.freeze_panes(1, 2)
            sheet.autofilter(0, 0, len(rows), column_count - 1)
            sheet.set_row(0, 27)
            sheet.set_column_pixels(0, 0, 145)
            sheet.set_column(1, 1, 30)
            sheet.set_column(2, 3, 54)
            sheet.set_column(4, 4, 66)
            sheet.set_column(5, column_count - 1, 53)
            for column, name in enumerate(headers):
                sheet.write_string(0, column, name, head)
            for row, (record, values) in enumerate(zip(records, rows), start=1):
                sheet.set_row(row, 126)
                sheet.embed_image(row, 0, record['imagePath'], {'description': record['name'], 'cell_format': cell})
                for column, value in enumerate(values, start=1):
                    if sheet.write_string(row, column, value, cell) != 0:
                        raise ValueError('文本超过 Excel 单元格长度上限')
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    if len(sys.argv) != 2:
        raise ValueError('需要指定 Excel 输出文件路径')
    create_workbook(Path(sys.argv[1]), json.load(sys.stdin))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError) as error:
        sys.exit(str(error))
