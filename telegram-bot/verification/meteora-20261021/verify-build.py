#!/usr/bin/env python3
"""Compare explicitly supplied public binaries with the reviewed Meteora build."""
import argparse
import hashlib
import json
from pathlib import Path


def read_public_binary(path, expected_size):
    path = Path(path)
    if not path.is_file() or path.stat().st_size != expected_size:
        raise ValueError('unexpected public binary size or type')
    data = path.read_bytes()
    if len(data) != expected_size or not data.startswith(b'\x7fELF'):
        raise ValueError('invalid public ELF payload')
    return data


def verify(program_path, rebuilt_path):
    proof = json.loads(Path(__file__).with_name('linux-source-proof.json').read_text())
    program = read_public_binary(program_path, 2174352)
    rebuilt = read_public_binary(rebuilt_path, proof['rebuiltBytes'])
    sha256 = lambda data: hashlib.sha256(data).hexdigest()
    if sha256(program) != proof['paddedPayloadSha256']:
        raise ValueError('deployed payload hash differs from review')
    if sha256(rebuilt) != proof['rebuiltSha256']:
        raise ValueError('rebuilt ELF hash differs from review')
    if sha256(program.rstrip(b'\0')) != proof['mainnetTrimmedSha256']:
        raise ValueError('trimmed payload hash differs from review')
    if rebuilt + bytes(len(program) - len(rebuilt)) != program:
        raise ValueError('rebuilt ELF plus zero padding is not the deployed payload')
    return {'exactPayloadMatch': True, 'sha256': sha256(program),
            'readOnly': True, 'authorityCheckedByThisCommand': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--program', required=True, help='public deployed payload, without loader metadata')
    parser.add_argument('--rebuilt', required=True, help='public independently rebuilt ELF')
    args = parser.parse_args()
    try:
        result = verify(args.program, args.rebuilt)
    except (ValueError, OSError, KeyError):
        parser.exit(1, 'Public build verification failed. No files were changed.\n')
    print(json.dumps(result, indent=2))
