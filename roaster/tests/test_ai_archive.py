"""Cross-platform delivery permissions; no backend or hardware startup."""
import importlib.util
from pathlib import Path
import tarfile
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[2] / "desktop/tools/package-ai-archive.py"
spec = importlib.util.spec_from_file_location("ai_archive", MODULE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArchiveTests(unittest.TestCase):
    def test_linux_node_is_executable_and_archive_is_reproducible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stage"
            binary = source / "runtime/node/bin/node"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"\x7fELF-test")
            (source / "config.example.yaml").write_text("ai: {}\n", encoding="utf-8")
            first, second = root / "one.tar.gz", root / "two.tar.gz"
            module.create_archive(source, first)
            module.create_archive(source, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with tarfile.open(first) as archive:
                members = {m.name.removeprefix("./"): m for m in archive.getmembers()}
                self.assertEqual(members["runtime/node/bin/node"].mode, 0o755)
                self.assertEqual(members["config.example.yaml"].mode, 0o644)


if __name__ == "__main__":
    unittest.main()
