#!/usr/bin/env python3
"""Run a deterministic, complete partition slice of the final-binary E2E suite."""
import argparse
import subprocess
import sys


def discover_tests(package: str, target: str) -> list[str]:
    result = subprocess.run(
        [
            "cargo",
            "test",
            "-p",
            package,
            "--test",
            target,
            "--locked",
            "--",
            "--list",
            "--format=terse",
        ],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    tests = sorted(
        {
            line[: -len(": test")].strip()
            for line in result.stdout.splitlines()
            if line.endswith(": test") and line[: -len(": test")].strip()
        }
    )
    if not tests:
        raise RuntimeError(f"no tests discovered for {package} --test {target}")
    return tests


def partition(tests: list[str], shard: int, shards: int) -> list[str]:
    if shards < 1 or shard < 1 or shard > shards:
        raise ValueError(f"invalid shard {shard}/{shards}")
    buckets = [tests[offset::shards] for offset in range(shards)]
    covered = [name for bucket in buckets for name in bucket]
    if len(covered) != len(tests) or set(covered) != set(tests):
        raise RuntimeError("shard partition is not a complete bijection")
    selected = buckets[shard - 1]
    if not selected:
        raise RuntimeError(f"shard {shard}/{shards} is empty for {len(tests)} tests")
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shard", type=int, required=True, help="1-based shard index")
    parser.add_argument("--shards", type=int, required=True, help="Total shard count")
    parser.add_argument("--package", default="latte-work-server")
    parser.add_argument("--test", default="e2e", dest="target")
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Compile, list, and verify shard completeness without running tests",
    )
    args = parser.parse_args()

    tests = discover_tests(args.package, args.target)
    selected = partition(tests, args.shard, args.shards)
    print(
        f"E2E shard {args.shard}/{args.shards}: selected {len(selected)} of {len(tests)} tests",
        flush=True,
    )
    if args.verify_only:
        return 0

    completed = subprocess.run(
        [
            "cargo",
            "test",
            "-p",
            args.package,
            "--test",
            args.target,
            "--locked",
            "--",
            "--exact",
            *selected,
            "--test-threads=1",
        ],
        check=False,
    )
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
