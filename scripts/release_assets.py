#!/usr/bin/env python3
"""Prepare installers for a GitHub release and write the release notes.

GitHub refuses release files of 2 GiB or more, and the macOS and Linux installers carry a 2.5 GB
language model. ``split`` therefore copies small installers as they are and cuts larger ones into
numbered parts (``<name>.part1``, ``<name>.part2``, ...) that are joined back byte for byte before
installing; it also records each installer's size and SHA-256 in ``<platform>.json``. ``notes``
reads those records and writes the release page: what to download for each computer, how to join
parts, how to open an installer that is not code-signed, and ``SHA256SUMS.txt``.

    python3 scripts/release_assets.py split --platform linux-x64 --out dist-release FILE...
    python3 scripts/release_assets.py notes --tag v1.0.0 --repo owner/name --meta-dir meta \\
        --sums SHA256SUMS.txt --run-url URL > notes.md

Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

LIMIT = 2_000_000_000  # bytes; GitHub's limit is 2 GiB (2,147,483,648) per release file
PART = 1_900_000_000

PLATFORMS = [
    ("windows-x64", "Windows 10 or 11 (64-bit)"),
    ("macos-arm64", "Mac with Apple silicon (M1 or newer)"),
    ("macos-x64", "Mac with an Intel processor"),
    ("linux-x64", "Linux (64-bit)"),
]


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 22), b""):
            digest.update(block)
    return digest.hexdigest()


def split(opts: argparse.Namespace) -> int:
    out: Path = opts.out
    out.mkdir(parents=True, exist_ok=True)
    records = []
    for path in opts.files:
        size = path.stat().st_size
        record = {"name": path.name, "size": size, "sha256": sha256_of(path), "parts": []}
        if size < LIMIT:
            try:
                os.link(path, out / path.name)  # no second copy on the runner's disk
            except OSError:
                shutil.copyfile(path, out / path.name)
        else:
            with path.open("rb") as src:
                index = 1
                while chunk := src.read(PART):
                    part = out / f"{path.name}.part{index}"
                    part.write_bytes(chunk)
                    record["parts"].append(part.name)
                    index += 1
        records.append(record)
        shown = f"{len(record['parts'])} parts" if record["parts"] else "single file"
        print(f"{path.name}: {size / 1e9:.2f} GB, {shown}, sha256 {record['sha256']}")
    meta = {"platform": opts.platform, "installers": records}
    if opts.macos_minimum:
        meta["macosMinimum"] = opts.macos_minimum
    (opts.meta_out or out / f"{opts.platform}.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return 0


def describe(name: str) -> str:
    if name.endswith("-setup.exe"):
        return "installer (recommended)"
    if name.endswith(".msi"):
        return "Windows Installer package, for managed installs"
    if name.endswith(".dmg"):
        return "disk image"
    if name.endswith(".deb"):
        return "Ubuntu, Debian, Linux Mint and other Debian-based systems"
    if name.endswith(".AppImage"):
        return "any other distribution; runs without installing"
    return ""


def notes(opts: argparse.Namespace) -> int:
    metas = {}
    for path in sorted(opts.meta_dir.rglob("*.json")):
        meta = json.loads(path.read_text(encoding="utf-8"))
        metas[meta["platform"]] = meta
    version = opts.tag.lstrip("v")
    base = f"https://github.com/{opts.repo}/releases/download/{opts.tag}"
    lines = [f"MoleculeForge {version}: build, validate and simulate molecules on your own computer. "
             "Everything, including the AI assistant, runs offline once installed.", "",
             "## Download", "", "Pick the row for your computer.", "",
             "| Computer | Download | Size |", "|---|---|---|"]
    sums = []
    split_any = []
    for key, label in PLATFORMS:
        meta = metas.get(key)
        if not meta:
            continue
        for inst in sorted(meta["installers"], key=lambda i: (not i["name"].endswith("-setup.exe"), i["name"])):
            sums.append(f"{inst['sha256']}  {inst['name']}")
            files = inst["parts"] or [inst["name"]]
            links = " + ".join(f"[{f}]({base}/{f})" for f in files)
            what = describe(inst["name"])
            lines.append(f"| {label} | {links}<br>{what} | {inst['size'] / 1e9:.1f} GB |")
            if inst["parts"]:
                split_any.append(inst)
    if split_any:
        lines += ["", "### Files in parts", "",
                  "GitHub limits each download to 2 GB, so installers that include the larger AI model are split. "
                  "Download every part into the same folder, then join them: open Terminal, go to that folder "
                  "(for your Downloads folder, run `cd ~/Downloads`) and run the line for your file:", ""]
        for inst in split_any:
            if inst["name"].endswith((".exe", ".msi")):
                lines += ["```bat", f"copy /b {' + '.join(inst['parts'])} {inst['name']}", "```", ""]
            else:
                lines += ["```bash", f"cat {' '.join(inst['parts'])} > {inst['name']}", "```", ""]
        lines += ["The joined file is the installer. You can delete the parts afterwards."]
    if opts.run_url:
        lines += ["", f"The same installers are also available unsplit, for 90 days after the build, as artifacts of "
                      f"[the build run]({opts.run_url}) (sign in to GitHub to download)."]
    mac_min = max((m.get("macosMinimum", "14.0") for k, m in metas.items() if k.startswith("macos")),
                  key=lambda v: tuple(int(x) for x in v.split(".")), default="14.0")
    lines += [
        "", "## Install", "",
        "These installers are not code-signed, so the operating system asks you to confirm the first time.", "",
        "**Windows**: run the `-setup.exe`. If Windows SmartScreen says *Windows protected your PC*, click "
        "**More info**, then **Run anyway**.", "",
        "**macOS**: open the `.dmg` and drag MoleculeForge into Applications, then open it from Applications. "
        "If macOS says it cannot verify the app, or that the app *is damaged*, run this in Terminal (it tells "
        "macOS you trust this app and the engines inside it) and open the app again:", "",
        "```bash", "xattr -cr /Applications/MoleculeForge.app", "```", "",
        "(Alternatively, click **Done**, open **System Settings > Privacy & Security**, scroll down and click "
        "**Open Anyway**.)", "",
        "**Linux**: install the `.deb` with",
        "", "```bash", f"sudo apt install ./MoleculeForge_{version}_amd64.deb", "```", "",
        "or make the AppImage executable and run it:", "",
        "```bash", f"chmod +x MoleculeForge_{version}_amd64.AppImage", f"./MoleculeForge_{version}_amd64.AppImage",
        "```", "",
        "## Requirements", "",
        f"- Windows 10 (version 1809 or later) or 11, 64-bit; macOS {mac_min} or later; or 64-bit Linux "
        "with glibc 2.35 or later (Ubuntu 22.04, Debian 12, Fedora 36 or newer).",
        "- 8 GB of memory (16 GB is more comfortable for the AI assistant and large molecules) and about 7 GB "
        "of free disk space.",
        "- No internet connection is needed after installation.", "",
        "## AI model", "",
        "The macOS and Linux installers include Qwen3-4B-Instruct-2507 (Q4_K_M). Windows installers cannot "
        "exceed 2 GB, so the Windows version includes the smaller Qwen3-1.7B. To use the larger model on "
        "Windows, download `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` from "
        "[Hugging Face](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF) and choose it in "
        "**Assistant > Language model**.", "",
        "## Check a download (optional)", "",
        "`SHA256SUMS.txt` lists the SHA-256 of every installer (joined, for those in parts). Compare it with "
        "`shasum -a 256 FILE` on a Mac, `sha256sum FILE` on Linux, or `certutil -hashfile FILE SHA256` on Windows.",
    ]
    if opts.sums:
        opts.sums.write_text("\n".join(sums) + "\n", encoding="utf-8")
    sys.stdout.write("\n".join(lines) + "\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p_split = sub.add_parser("split", help="copy or split installers into a release folder")
    p_split.add_argument("--platform", required=True)
    p_split.add_argument("--out", type=Path, required=True)
    p_split.add_argument("--meta-out", type=Path, help="where to write <platform>.json (default: inside --out)")
    p_split.add_argument("--macos-minimum", help="minimum macOS the bundle declares")
    p_split.add_argument("files", type=Path, nargs="+")
    p_notes = sub.add_parser("notes", help="write release notes (stdout) and SHA256SUMS.txt")
    p_notes.add_argument("--tag", required=True)
    p_notes.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", "owner/name"))
    p_notes.add_argument("--meta-dir", type=Path, required=True)
    p_notes.add_argument("--sums", type=Path)
    p_notes.add_argument("--run-url")
    opts = parser.parse_args()
    return split(opts) if opts.command == "split" else notes(opts)


if __name__ == "__main__":
    sys.exit(main())
