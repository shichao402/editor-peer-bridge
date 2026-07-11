#!/usr/bin/env python3
"""
GitHub release orchestrator: VERSION (SSOT) -> tag -> CI Package -> GitHub Release.

Does NOT publish to application marketplaces. Use `npm run release` for that.

SSOT:
  VERSION              release version number
  scripts/version.mjs  sync/check derived package metadata (via npm)

Prerequisites:
  git, npm, gh (authenticated)

Usage:
  python scripts/github_release.py           # ship: preflight, tag, push, wait CI
  python scripts/github_release.py ship      # same as default
  python scripts/github_release.py tag       # preflight + create/push tag only
  python scripts/github_release.py wait      # wait for Package workflow (current VERSION)
  python scripts/github_release.py release   # create GitHub Release from CI artifacts
  python scripts/github_release.py status    # show version / tag / CI state

Options:
  --dry-run    show planned actions only
  -y, --yes    skip confirmation prompts
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

WORKFLOW_NAME = "Package"
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")


class ReleaseError(Exception):
    pass


def repo_root() -> Path:
    root = Path(__file__).resolve().parent.parent
    if not (root / "VERSION").is_file():
        raise ReleaseError(f"Not at repository root (missing VERSION): {root}")
    return root


def run(
    cmd: list[str],
    *,
    cwd: Path,
    check: bool = True,
    capture: bool = False,
    dry_run: bool = False,
) -> subprocess.CompletedProcess[str]:
    label = " ".join(cmd)
    if dry_run:
        print(f"[dry-run] {label}")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    print(f"> {label}")
    return subprocess.run(
        cmd,
        cwd=cwd,
        check=check,
        text=True,
        capture_output=capture,
    )


def read_version(root: Path) -> str:
    version = (root / "VERSION").read_text(encoding="utf-8").strip()
    if not VERSION_PATTERN.match(version):
        raise ReleaseError(f'Invalid VERSION "{version}". Expected semver like 0.0.17.')
    return version


def tag_name(version: str) -> str:
    return f"v{version}"


def npm_run(root: Path, script: str, *, extra_args: list[str] | None = None, dry_run: bool = False) -> None:
    cmd = ["npm", "run", script, "--"]
    if extra_args:
        cmd.extend(extra_args)
    run(cmd, cwd=root, dry_run=dry_run)


def git_output(root: Path, *args: str) -> str:
    result = run(["git", *args], cwd=root, capture=True)
    return (result.stdout or "").strip()


def default_branch(root: Path) -> str:
    try:
        ref = git_output(root, "symbolic-ref", "refs/remotes/origin/HEAD")
        return ref.removeprefix("refs/remotes/origin/")
    except subprocess.CalledProcessError:
        return "master"


def require_tools() -> None:
    for tool in ("git", "npm", "gh"):
        if shutil.which(tool) is None:
            raise ReleaseError(f"Required tool not found on PATH: {tool}")


def preflight(root: Path, version: str, *, dry_run: bool) -> str:
    """Validate repo state. Returns tag for version."""
    tag = tag_name(version)
    branch = default_branch(root)

    npm_run(root, "version:check", dry_run=dry_run)
    if not dry_run:
        npm_run(root, "version:check-tag", extra_args=[tag])

    if not dry_run:
        current = git_output(root, "rev-parse", "--abbrev-ref", "HEAD")
        if current != branch:
            raise ReleaseError(f"Expected branch {branch!r}, currently on {current!r}.")

        if git_output(root, "status", "--porcelain"):
            raise ReleaseError("Working tree is not clean. Commit or stash changes first.")

        local_head = git_output(root, "rev-parse", "HEAD")
        try:
            remote_head = git_output(root, "rev-parse", f"origin/{branch}")
        except subprocess.CalledProcessError:
            raise ReleaseError(f"Remote branch origin/{branch} not found. Push mainline first.") from None

        if local_head != remote_head:
            raise ReleaseError(
                f"HEAD is not synced with origin/{branch}. Push commits before tagging."
            )

        if git_output(root, "tag", "-l", tag):
            raise ReleaseError(f"Local tag {tag} already exists.")

        remote_tags = run(
            ["git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}"],
            cwd=root,
            capture=True,
            check=False,
        ).stdout.strip()
        if remote_tags:
            raise ReleaseError(f"Remote tag {tag} already exists on origin.")

    changelog = root / "CHANGELOG.md"
    if changelog.is_file() and version not in changelog.read_text(encoding="utf-8"):
        print(f"[warn] CHANGELOG.md does not mention version {version}.")

    return tag


def confirm(message: str, *, assume_yes: bool) -> None:
    if assume_yes:
        return
    answer = input(f"{message} [y/N] ").strip().lower()
    if answer not in ("y", "yes"):
        raise ReleaseError("Aborted.")


def cmd_tag(root: Path, version: str, *, dry_run: bool, assume_yes: bool) -> str:
    tag = preflight(root, version, dry_run=dry_run)
    confirm(f"Create and push tag {tag} for VERSION {version}?", assume_yes=assume_yes)
    run(["git", "tag", tag], cwd=root, dry_run=dry_run)
    run(["git", "push", "origin", tag], cwd=root, dry_run=dry_run)
    print(f"Tagged and pushed {tag}.")
    return tag


def gh_json(root: Path, args: list[str], *, dry_run: bool = False) -> object:
    if dry_run:
        return []
    result = run(["gh", *args, "--json", "databaseId,status,conclusion,headBranch,url,createdAt"], cwd=root, capture=True)
    return json.loads(result.stdout or "[]")


def find_package_run(root: Path, tag: str, *, dry_run: bool = False) -> dict | None:
    if dry_run:
        return {
            "databaseId": 0,
            "status": "completed",
            "conclusion": "success",
            "headBranch": tag,
            "url": "(dry-run)",
            "createdAt": "",
        }

    runs = gh_json(
        root,
        ["run", "list", "--workflow", WORKFLOW_NAME, "--limit", "30"],
    )
    if not isinstance(runs, list):
        return None

    for run in runs:
        if run.get("headBranch") == tag:
            return run
    return None


def wait_for_package(root: Path, tag: str, *, dry_run: bool, timeout_sec: int = 3600) -> dict:
    if dry_run:
        print(f"[dry-run] would wait for {WORKFLOW_NAME} workflow on {tag}")
        return find_package_run(root, tag, dry_run=True)  # type: ignore[return-value]

    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        run = find_package_run(root, tag)
        if run:
            status = run.get("status")
            conclusion = run.get("conclusion")
            print(f"Workflow {run['databaseId']}: status={status} conclusion={conclusion}")
            if status == "completed":
                if conclusion == "success":
                    print(f"Package workflow succeeded: {run.get('url')}")
                    return run
                raise ReleaseError(
                    f"Package workflow failed ({conclusion}): {run.get('url')}"
                )
            run_id = str(run["databaseId"])
            watch = run(["gh", "run", "watch", run_id, "--exit-status"], cwd=root, check=False)
            if watch.returncode == 0:
                refreshed = find_package_run(root, tag)
                if refreshed and refreshed.get("conclusion") == "success":
                    print(f"Package workflow succeeded: {refreshed.get('url')}")
                    return refreshed
                raise ReleaseError(f"Package workflow did not succeed for {tag}.")
            raise ReleaseError(f"gh run watch failed for run {run_id}.")
        print(f"Waiting for {WORKFLOW_NAME} run on {tag}...")
        time.sleep(10)

    raise ReleaseError(f"Timed out waiting for {WORKFLOW_NAME} on {tag}.")


def release_notes(root: Path, version: str) -> str:
    changelog = root / "CHANGELOG.md"
    if not changelog.is_file():
        return f"Release {tag_name(version)}"

    text = changelog.read_text(encoding="utf-8")
    header = f"## [{version}]"
    start = text.find(header)
    if start < 0:
        return f"Release {tag_name(version)}"

    rest = text[start + len(header) :]
    next_header = rest.find("\n## [")
    section = rest[:next_header] if next_header >= 0 else rest
    body = section.strip()
    return body or f"Release {tag_name(version)}"


def gh_release_exists(root: Path, tag: str, *, dry_run: bool) -> bool:
    if dry_run:
        return False
    result = run(
        ["gh", "release", "view", tag],
        cwd=root,
        check=False,
        capture=True,
    )
    return result.returncode == 0


def cmd_release(root: Path, version: str, *, dry_run: bool, assume_yes: bool) -> None:
    tag = tag_name(version)
    run_info = find_package_run(root, tag)
    if not run_info or run_info.get("conclusion") != "success":
        raise ReleaseError(
            f"No successful {WORKFLOW_NAME} run for {tag}. Run `wait` first or check Actions."
        )

    if gh_release_exists(root, tag, dry_run=dry_run):
        print(f"GitHub Release {tag} already exists. Skipping create.")
        return

    confirm(f"Create GitHub Release {tag} from CI artifacts?", assume_yes=assume_yes)

    with tempfile.TemporaryDirectory(prefix="github-release-") as tmp:
        tmp_path = Path(tmp)
        if not dry_run:
            run(
                ["gh", "run", "download", str(run_info["databaseId"]), "--dir", str(tmp_path)],
                cwd=root,
            )

        assets: list[Path] = []
        if not dry_run:
            assets = sorted(tmp_path.rglob("*.vsix")) + sorted(tmp_path.rglob("*.zip"))
            if not assets:
                raise ReleaseError(f"No .vsix or .zip artifacts downloaded for run {run_info['databaseId']}.")

        notes_file = tmp_path / "release-notes.md"
        if not dry_run:
            notes_file.write_text(release_notes(root, version), encoding="utf-8")

        cmd = [
            "gh",
            "release",
            "create",
            tag,
            "--title",
            tag,
            "--notes-file",
            str(notes_file),
            *[str(p) for p in assets],
        ]
        run(cmd, cwd=root, dry_run=dry_run)

    print(f"GitHub Release {tag} created.")
    print("Marketplace publish is unchanged — use: npm run release -- --from-tag", tag)


def cmd_status(root: Path, version: str) -> None:
    tag = tag_name(version)
    branch = default_branch(root)

    print(f"VERSION:  {version}")
    print(f"tag:      {tag}")
    print(f"branch:   {branch} (current: {git_output(root, 'rev-parse', '--abbrev-ref', 'HEAD')})")

    dirty = bool(git_output(root, "status", "--porcelain"))
    print(f"git clean: {'no' if dirty else 'yes'}")

    local_tag = bool(git_output(root, "tag", "-l", tag))
    remote_tag = bool(
        run(
            ["git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}"],
            cwd=root,
            capture=True,
            check=False,
        ).stdout.strip()
    )
    print(f"tag local:  {'yes' if local_tag else 'no'}")
    print(f"tag remote: {'yes' if remote_tag else 'no'}")

    run_info = find_package_run(root, tag)
    if run_info:
        print(
            "CI Package: "
            f"id={run_info.get('databaseId')} "
            f"status={run_info.get('status')} "
            f"conclusion={run_info.get('conclusion')}"
        )
        if run_info.get("url"):
            print(f"CI url:     {run_info['url']}")
    else:
        print("CI Package: (no run found)")

    print(f"GH Release: {'yes' if gh_release_exists(root, tag, dry_run=False) else 'no'}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="GitHub tag -> CI Package -> GitHub Release (VERSION is SSOT).",
    )
    parser.add_argument(
        "command",
        nargs="?",
        default="ship",
        choices=("ship", "tag", "wait", "release", "status"),
        help="ship=tag+push+wait (default); release does not touch marketplaces",
    )
    parser.add_argument("--dry-run", action="store_true", help="show actions without executing")
    parser.add_argument("-y", "--yes", action="store_true", help="skip confirmation prompts")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        require_tools()
        root = repo_root()
        version = read_version(root)
        tag = tag_name(version)

        if args.command == "status":
            cmd_status(root, version)
            return 0

        if args.command == "tag":
            cmd_tag(root, version, dry_run=args.dry_run, assume_yes=args.yes)
            return 0

        if args.command == "wait":
            wait_for_package(root, tag, dry_run=args.dry_run)
            return 0

        if args.command == "release":
            cmd_release(root, version, dry_run=args.dry_run, assume_yes=args.yes)
            return 0

        if args.command == "ship":
            cmd_tag(root, version, dry_run=args.dry_run, assume_yes=args.yes)
            wait_for_package(root, tag, dry_run=args.dry_run)
            print()
            print("Next:")
            print(f"  python scripts/github_release.py release   # GitHub Release + artifacts")
            print(f"  npm run release -- --from-tag {tag}        # marketplaces (existing flow)")
            return 0

        parser.error(f"Unknown command: {args.command}")
        return 2

    except ReleaseError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as err:
        cmd = " ".join(err.cmd) if err.cmd else "(unknown)"
        print(f"error: command failed ({cmd})", file=sys.stderr)
        if err.stderr:
            print(err.stderr.strip(), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
