"""Build a Linux archive on any host, including Windows without POSIX mode bits."""
from __future__ import annotations

import gzip
from pathlib import Path
import sys
import tarfile


def create_archive(source: Path, output: Path) -> None:
    source, output = source.resolve(strict=True), output.resolve()
    if not source.is_dir() or output == source or source in output.parents:
        raise ValueError("归档输出必须位于构建目录之外")

    def normalize(info: tarfile.TarInfo):
        name = info.name.removeprefix("./")
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        info.mtime = 0
        info.mode = 0o755 if info.isdir() or name == "runtime/node/bin/node" or name.endswith(".sh") else 0o777 if info.issym() else 0o644
        return info

    with output.open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, filename="", mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                archive.add(source, arcname=".", filter=normalize)


if __name__ == "__main__":
    create_archive(Path(sys.argv[1]), Path(sys.argv[2]))
