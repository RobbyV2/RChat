"""Reference solver for scripts (spec "The puzzle"). Standard library only.

python3 -I scripts/pow/solve.py checks it against crates/pow/tests/vectors.json.
"""

import hashlib
import json
import pathlib
import struct


def seed_of(challenge: str) -> bytes:
    return hashlib.sha256(b"rchat-pow-seed1\0" + challenge.encode()).digest()


def wins(seed: bytes, sub: int, nonce: int, target: int) -> bool:
    h = hashlib.sha256(b"rchat-pow1" + seed + bytes([sub]) + struct.pack("<Q", nonce)).digest()
    return int.from_bytes(h[:8], "big") < target


def solve(challenge: str, k: int, target: int) -> list[int]:
    seed = seed_of(challenge)
    out = []
    for sub in range(k):
        n = 0
        while not wins(seed, sub, n, target):
            n += 1
        out.append(n)
    return out


def wire(nonces: list[int]) -> str:
    return "".join(struct.pack("<Q", n).hex() for n in nonces)


if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parents[2]
    v = json.loads((root / "crates" / "pow" / "tests" / "vectors.json").read_text())
    assert seed_of(v["challenge"]).hex() == v["seed_hex"]
    nonces = solve(v["challenge"], v["k"], int(v["target"]))
    assert [str(n) for n in nonces] == v["nonces"], nonces
    assert wire(nonces) == v["nonces_wire"]
    print("python reference solver matches the vectors")
