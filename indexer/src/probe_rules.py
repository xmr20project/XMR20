MAGIC = b'XMR20M1'

def require(ok, msg):
    if not ok:
        raise ValueError(msg)

def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=True)

def atomic(path, v):
    path = Path(path)
    previous = path.stat() if path.exists() else path.parent.stat() if os.geteuid() == 0 else None
    tmp = path.with_suffix('.next')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 384)
    try:
        os.fchmod(fd, 384)
        if previous is not None:
            os.fchown(fd, previous.st_uid, previous.st_gid)
    except BaseException:
        os.close(fd)
        raise
    with os.fdopen(fd, 'w') as f:
        json.dump(v, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def chain(c):
    results = []
    for url in c['daemonUrls']:
        r = daemon(url, 'get_info')
        require(r.get('status') == 'OK' and r.get('nettype') == 'mainnet' and r.get('mainnet') and r.get('synchronized') and (not r.get('offline')), 'Synced MAINNET daemon required')
        results.append(r)
    require(len(results) == 2 and abs(results[0]['height'] - results[1]['height']) <= 2, 'Mainnet nodes disagree')
    h = min((r['height'] for r in results)) - 1
    headers = [daemon(u, 'get_block_header_by_height', {'height': h})['block_header'] for u in c['daemonUrls']]
    require(headers[0]['hash'] == headers[1]['hash'] and (not any((x.get('orphan_status') for x in headers))), 'Mainnet nodes disagree on block hash')
    return results[0]['height']

class Reader:

    def __init__(self, b):
        self.b = b
        self.at = 0

    def take(self, n):
        require(0 <= n <= len(self.b) - self.at, 'Truncated transaction')
        v = self.b[self.at:self.at + n]
        self.at += n
        return v

    def byte(self):
        return self.take(1)[0]

    def varint(self, limit=(1 << 64) - 1):
        n = 0
        for i in range(10):
            b = self.byte()
            n |= (b & 127) << 7 * i
            if not b & 128:
                require(not (i and b == 0) and n <= limit, 'Invalid varint')
                return n
        raise ValueError('Invalid varint')

def extract(extra):
    require(len(extra) <= 1060, 'Oversized extra')
    r = Reader(bytes(extra))
    chunks = []
    while r.at < len(r.b):
        tag = r.byte()
        if tag == 0:
            require(not any(r.take(len(r.b) - r.at)), 'Bad padding')
        elif tag == 1:
            r.take(32)
        elif tag == 4:
            r.take(32 * r.varint(16))
        elif tag == 2:
            nonce = r.take(r.varint(255))
            if nonce.startswith(b'XM2'):
                chunks.append(nonce)
        else:
            raise ValueError('Unknown extra tag')
    require(chunks and len(chunks[0]) > 5, 'Missing probe')
    total = chunks[0][4]
    require(1 <= total <= 4 and len(chunks) == total, 'Invalid fragment count')
    for (i, c) in enumerate(chunks):
        require(len(c) > 5 and c[3] == i and (c[4] == total) and (len(c) == 245 if i < total - 1 else len(c) <= 245), 'Invalid fragment order')
    payload = b''.join((c[5:] for c in chunks))
    require(payload.startswith(MAGIC) and len(payload) <= 800, 'Wrong mainnet probe domain')
    return payload
