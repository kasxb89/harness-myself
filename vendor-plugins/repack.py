#!/usr/bin/env python3
"""Repack the verified Video Studio release files without executing package code."""

import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile


def main():
    directory = Path(__file__).resolve().parent
    metadata = json.loads((directory / "deepseek-ivideo-0.5.0.files.json").read_text())
    source = Path(sys.argv[1]).resolve()
    output = directory / metadata["tarball"]
    with output.open("wb") as destination:
        with gzip.GzipFile(filename="", fileobj=destination, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for name, expected in sorted(metadata["files"].items()):
                    path = source / name
                    if path.is_symlink() or source not in path.resolve().parents:
                        raise ValueError("Release file escapes the source directory: " + name)
                    data = path.read_bytes()
                    if len(data) != expected["size"] or hashlib.sha512(data).hexdigest() != expected["sha512"]:
                        raise ValueError("Release file integrity mismatch: " + name)
                    entry = tarfile.TarInfo("package/" + name)
                    entry.size = len(data)
                    entry.mode = expected["mode"]
                    entry.mtime = 0
                    archive.addfile(entry, io.BytesIO(data))
    print(output.name + " sha512-" + hashlib.sha512(output.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
