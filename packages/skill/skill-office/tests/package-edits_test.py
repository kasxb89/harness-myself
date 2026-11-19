"""Exercise real OOXML edits and optionally retain a before/after local benchmark."""
import argparse
from collections import Counter
from contextlib import contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1] / "assets" / "scripts"
LIMITS = {"max_file_bytes": 52_428_800, "max_archive_entries": 10_000,
          "max_uncompressed_bytes": 262_144_000, "max_cells": 1_000_000,
          "max_items": 1_000_000, "max_inspect_items": 200,
          "max_preview_chars": 1000, "max_output_bytes": 131_072,
          "timeout_ms": 120_000}


def load_script(path):
    name = "office_edits_" + hashlib.sha256(str(path).encode()).hexdigest()[:12]
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    sys.path.insert(0, str(path.parent))
    try:
        specification.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


def members(path):
    with zipfile.ZipFile(path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


@contextmanager
def xml_counts(module):
    counts = {"parse": Counter(), "serialize": Counter()}
    original_parse, original_serialize = module.ET.fromstring, module.ET.tostring

    def parse_xml(*args, **kwargs):
        root = original_parse(*args, **kwargs)
        counts["parse"][module.ET.QName(root).localname] += 1
        return root

    def serialize_xml(root, *args, **kwargs):
        counts["serialize"][module.ET.QName(root).localname] += 1
        return original_serialize(root, *args, **kwargs)

    with patch.object(module.ET, "fromstring", parse_xml), patch.object(module.ET, "tostring", serialize_xml):
        yield counts


def check(path):
    checker = load_script(SCRIPTS / "check_office.py")
    summary, _text = checker.inspect(path)
    return summary


def workbook_fixture(path, rows=2000, columns=5):
    from openpyxl import Workbook
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "数据"
    for row in range(1, rows + 1):
        sheet.append([(row - 1) * columns + column for column in range(1, columns + 1)])
    workbook.save(path)
    workbook.close()


def word_fixture(path):
    from docx import Document
    document = Document()
    paragraph = document.add_paragraph()
    paragraph.add_run("Draft alpha").bold = True
    paragraph.add_run(" beta end").italic = True
    document.add_table(rows=1, cols=1).cell(0, 0).text = "Preserved table"
    document.save(path)


def presentation_fixture(path):
    from PIL import Image
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Inches
    image = path.with_suffix(".png")
    Image.new("RGB", (40, 30), "navy").save(image)
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    text = slide.shapes.add_textbox(Inches(1), Inches(.5), Inches(7), Inches(1))
    text.text = "Draft alpha"
    slide.shapes.add_picture(str(image), Inches(1), Inches(2), width=Inches(2))
    data = CategoryChartData()
    data.categories = ["Q1", "Q2"]
    data.add_series("Revenue", [12, 18])
    slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(4), Inches(2), Inches(4), Inches(3), data)
    slide.notes_slide.notes_text_frame.text = "Draft notes"
    presentation.save(path)
    return text.shape_id


def operations_for_cells(count=1000, columns=5):
    from openpyxl.utils.cell import get_column_letter
    return [{"kind": "cell", "sheet": "数据", "cell": f"{get_column_letter(index % columns + 1)}{index // columns + 1}",
             "value": 100_000 + index} for index in range(count)]


def run_patch(module, source, operations, directory):
    directory.mkdir()
    before = source.read_bytes()
    started = time.perf_counter()
    started_cpu = time.process_time()
    with xml_counts(module) as counts:
        package = module.Package(source, LIMITS)
        spec = {"source_path": str(source), "source_sha256": package.sha,
                "title": "Focused edits", "operations": operations}
        output, recalculated = module.patch(package, spec, LIMITS, directory)
    elapsed = time.perf_counter() - started
    cpu_elapsed = time.process_time() - started_cpu
    if source.read_bytes() != before:
        raise AssertionError("Source bytes changed")
    validation_started = time.perf_counter()
    summary = check(output)
    validation_seconds = time.perf_counter() - validation_started
    return output, {"elapsed_seconds": elapsed, "process_cpu_seconds": cpu_elapsed,
                    "validation_seconds": validation_seconds,
                    "xml_counts": {kind: dict(value) for kind, value in counts.items()},
                    "formula_recalculated": recalculated, "structural_check": summary,
                    "source_sha256": hashlib.sha256(before).hexdigest(),
                    "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest()}


class PackageEditsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_script(SCRIPTS / "office_package.py")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="office-package-edits-")
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def unchanged_parts(self, source, output, changed):
        original, edited = members(source), members(output)
        self.assertEqual(list(original), list(edited))
        self.assertTrue(all(original[name] == edited[name] for name in original if name not in changed))

    def test_many_existing_cells_parse_and_serialize_the_worksheet_once(self):
        from openpyxl import load_workbook
        source = self.root / "existing.xlsx"
        workbook_fixture(source, rows=200, columns=5)
        output, result = run_patch(self.module, source, operations_for_cells(), self.root / "patched")
        self.assertEqual(result["xml_counts"]["parse"].get("worksheet"), 1)
        self.assertEqual(result["xml_counts"]["serialize"].get("worksheet"), 1)
        workbook = load_workbook(output, data_only=False)
        self.addCleanup(workbook.close)
        values = [cell.value for row in workbook["数据"].iter_rows() for cell in row]
        self.assertEqual(values, list(range(100_000, 101_000)))
        self.unchanged_parts(source, output, {"xl/worksheets/sheet1.xml"})

    def test_repeated_same_cell_edits_observe_the_latest_value(self):
        from openpyxl import load_workbook
        source = self.root / "same-cell.xlsx"
        workbook_fixture(source, rows=2)
        output, _result = run_patch(self.module, source, [
            {"kind": "cell", "sheet": "数据", "cell": "A1", "value": "first"},
            {"kind": "cell", "sheet": "数据", "cell": "A1", "value": "final"},
        ], self.root / "patched")
        workbook = load_workbook(output)
        self.addCleanup(workbook.close)
        self.assertEqual(workbook["数据"]["A1"].value, "final")

    def test_repeated_word_replacements_preserve_the_other_runs_and_parts(self):
        from docx import Document
        source = self.root / "report.docx"
        word_fixture(source)
        operations = [{"kind": "word_text", "paragraph_index": 0, "old_text": old, "new_text": new}
                      for old, new in [("alpha", "intermediate"), ("intermediate", "final"), ("beta", "revised")]]
        output, result = run_patch(self.module, source, operations, self.root / "patched")
        paragraph = Document(output).paragraphs[0]
        self.assertEqual(paragraph.text, "Draft final revised end")
        self.assertTrue(paragraph.runs[0].bold)
        self.assertTrue(paragraph.runs[1].italic)
        self.assertEqual(result["xml_counts"]["parse"].get("document"), 1)
        self.assertEqual(result["xml_counts"]["serialize"].get("document"), 1)
        self.unchanged_parts(source, output, {"word/document.xml"})

    def test_powerpoint_keeps_chart_image_and_embedded_workbook_relationships(self):
        from pptx import Presentation
        source = self.root / "deck.pptx"
        shape_id = presentation_fixture(source)
        operations = [{"kind": "slide_text", "slide_number": 1, "shape_id": shape_id,
                       "old_text": old, "new_text": new}
                      for old, new in [("alpha", "intermediate"), ("intermediate", "final")]]
        operations += [{"kind": "slide_notes", "slide_number": 1, "old_text": "Draft notes", "new_text": "Final notes"}]
        output, _result = run_patch(self.module, source, operations, self.root / "patched")
        slide = Presentation(output).slides[0]
        self.assertEqual(next(shape.text for shape in slide.shapes if shape.shape_id == shape_id), "Draft final")
        self.assertEqual(slide.notes_slide.notes_text_frame.text, "Final notes")
        self.assertEqual(sum(shape.has_chart for shape in slide.shapes), 1)
        self.assertEqual(sum(shape.shape_type == 13 for shape in slide.shapes), 1)
        self.unchanged_parts(source, output, {"ppt/slides/slide1.xml", "ppt/notesSlides/notesSlide1.xml"})

    def protected_workbook(self):
        from openpyxl import Workbook
        from openpyxl.styles import Font
        from openpyxl.worksheet.formula import ArrayFormula
        source = self.root / "protected.xlsx"
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "数据"
        sheet["A1"], sheet["B1"], sheet["C1"] = 10, "=A1*2", 42
        sheet["C1"].font = Font(bold=True, color="FF0000")
        sheet["A4"] = ArrayFormula(ref="A4:A5", text="=ROW(A4:A5)*A1")
        sheet["A5"] = 50
        sheet.merge_cells("A7:B7")
        sheet["A7"] = "Merged heading"
        workbook.save(source)
        workbook.close()
        return source

    def test_number_formats_preserve_formulas_existing_styles_merges_and_array_extents(self):
        from openpyxl import load_workbook
        source = self.protected_workbook()
        output, result = run_patch(self.module, source, [
            {"kind": "cell", "sheet": "数据", "cell": "C1", "number_format": "0.00"},
            {"kind": "cell", "sheet": "数据", "cell": "C1", "number_format": "0.000"},
        ], self.root / "patched")
        self.assertFalse(result["formula_recalculated"])
        workbook = load_workbook(output)
        self.addCleanup(workbook.close)
        sheet = workbook["数据"]
        self.assertEqual(sheet["B1"].value, "=A1*2")
        self.assertEqual(sheet["C1"].number_format, "0.000")
        self.assertTrue(sheet["C1"].font.bold)
        self.assertEqual(sheet["C1"].font.color.rgb, "00FF0000")
        self.assertEqual(str(sheet.merged_cells), "A7:B7")
        self.assertEqual(sheet["A4"].value.ref, "A4:A5")
        self.unchanged_parts(source, output, {"xl/worksheets/sheet1.xml", "xl/styles.xml"})

    def test_merged_and_array_member_edits_fail_without_touching_the_source(self):
        source = self.protected_workbook()
        before = source.read_bytes()
        for coordinate, message in [("B7", "merged cell"), ("A4", "array"), ("A5", "array")]:
            with self.subTest(cell=coordinate):
                directory = self.root / coordinate
                directory.mkdir()
                package = self.module.Package(source, LIMITS)
                with self.assertRaisesRegex(ValueError, message):
                    self.module.patch(package, {"source_sha256": package.sha, "operations": [
                        {"kind": "cell", "sheet": "数据", "cell": coordinate, "value": 99},
                    ]}, LIMITS, directory)
                self.assertEqual(source.read_bytes(), before)
                self.assertEqual(list(directory.iterdir()), [])

    def test_calculation_copy_does_not_share_mutable_probe_trees(self):
        source = self.protected_workbook()
        original = self.module.Package(source, LIMITS)
        part = "xl/worksheets/sheet1.xml"
        original_tree = original.xml(part)
        original_tree.find("s:sheetData/s:row/s:c/s:v", self.module.NS).text = "111"
        original.save_xml(part, original_tree)
        duplicate = self.module.calculation_copy(original)
        duplicate_tree = duplicate.xml(part)
        self.assertIsNot(duplicate_tree, original_tree)
        node = duplicate_tree.find("s:sheetData/s:row/s:c/s:v", self.module.NS)
        old = original_tree.find("s:sheetData/s:row/s:c/s:v", self.module.NS).text
        node.text = "999"
        duplicate.save_xml(part, duplicate_tree)
        duplicate.write(self.root / "probe.xlsx")
        original.write(self.root / "original.xlsx")
        self.assertEqual(original_tree.find("s:sheetData/s:row/s:c/s:v", self.module.NS).text, old)
        saved = self.module.ET.fromstring(members(self.root / "original.xlsx")[part])
        self.assertEqual(saved.find("s:sheetData/s:row/s:c/s:v", self.module.NS).text, "111")
        self.assertNotEqual(members(self.root / "probe.xlsx")[part], members(self.root / "original.xlsx")[part])
        check(self.root / "probe.xlsx")
        check(self.root / "original.xlsx")


def benchmark(arguments):
    from openpyxl import load_workbook
    baseline = arguments.benchmark.resolve()
    if baseline.is_dir():
        baseline /= "office_package.py"
    root = arguments.artifacts.resolve()
    root.mkdir(parents=True, exist_ok=True)
    fixture = root / "fixture.xlsx"
    operation_file = root / "operations.json"
    if not fixture.exists():
        workbook_fixture(fixture, arguments.rows, arguments.columns)
        operation_file.write_text(json.dumps(operations_for_cells(arguments.edits, arguments.columns)), encoding="utf-8")
    operations = json.loads(operation_file.read_text(encoding="utf-8"))
    phases = ["baseline", "after"] if arguments.phase == "both" else [arguments.phase]
    for phase in phases:
        script = baseline if phase == "baseline" else SCRIPTS / "office_package.py"
        script_sha = hashlib.sha256(script.read_bytes()).hexdigest()
        report = root / (phase + ".json")
        if report.exists():
            raise ValueError(f"Refusing to overwrite benchmark evidence: {report}")
        output, result = run_patch(load_script(script), fixture, operations, root / phase)
        workbook = load_workbook(output, data_only=False)
        try:
            for operation in operations:
                if workbook["数据"][operation["cell"]].value != operation["value"]:
                    raise AssertionError("The edited workbook does not contain every requested value")
            dimensions = {"rows": workbook["数据"].max_row, "columns": workbook["数据"].max_column,
                          "cells": workbook["数据"].max_row * workbook["数据"].max_column, "edits": len(operations)}
        finally:
            workbook.close()
        if hashlib.sha256(script.read_bytes()).hexdigest() != script_sha:
            raise AssertionError("The benchmark script changed during execution")
        result.update({"phase": phase, "script": str(script), "script_sha256": script_sha,
                       "fixture": str(fixture), "output": str(output), "dimensions": dimensions,
                       "python": sys.executable, "python_version": sys.version, "verified_values": len(operations),
                       "scope": "Local package loading, edits and write only; excludes model latency, content authoring, image sourcing and rendering. Wall times may include system contention."})
        report.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
    if (root / "baseline.json").exists() and (root / "after.json").exists():
        before = json.loads((root / "baseline.json").read_text(encoding="utf-8"))
        after = json.loads((root / "after.json").read_text(encoding="utf-8"))
        if before["source_sha256"] != after["source_sha256"] or before["dimensions"] != after["dimensions"]:
            raise AssertionError("Before/after benchmark inputs differ")
        print(json.dumps({"speedup": before["elapsed_seconds"] / after["elapsed_seconds"],
                          "baseline_seconds": before["elapsed_seconds"], "after_seconds": after["elapsed_seconds"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--benchmark", type=Path)
    parser.add_argument("--artifacts", type=Path)
    parser.add_argument("--phase", choices=["baseline", "after", "both"], default="both")
    parser.add_argument("--rows", type=int, default=2000)
    parser.add_argument("--columns", type=int, default=5)
    parser.add_argument("--edits", type=int, default=1000)
    arguments, remaining = parser.parse_known_args()
    if arguments.benchmark is not None:
        if arguments.artifacts is None or min(arguments.rows, arguments.columns, arguments.edits) < 1 or arguments.edits > arguments.rows * arguments.columns:
            parser.error("benchmark needs --artifacts and existing-cell dimensions covering all edits")
        benchmark(arguments)
    else:
        unittest.main(argv=[sys.argv[0], *remaining])
