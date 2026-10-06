DOMAIN = 'MOUSE-ROAD-XMR20-MAINNET-BRIDGE-V1\n'
TRANSFER_DOMAIN = 'MOUSE-ROAD-XMR20-MAINNET-TRANSFER-V1\n'
LIMIT = 50000000000000
SCAN_CACHE_VERSION = 2

def scan_cache_path(c):
    policy = {'version': SCAN_CACHE_VERSION, **{k: c.get(k) for k in ('network', 'address', 'bridgeStartHeight', 'transferStartHeight', 'daemonUrls', 'replayHeight')}}
    digest = hashlib.sha256(canonical(policy).encode()).hexdigest()
    return Path(c['dataDir']) / ('bridge-chain-cache-v2-' + digest + '.json')

def validate(c, r):
    require(type(r) is dict, 'Invalid mainnet bridge record')
    if r.get('op') == 'deploy':
        return launch.validate_record(c, r)
    fields = {'p', 'v', 'net', 'op', 'owner', 'nonce', 'token', 'amount', 'to'}
    if r.get('op') == 'credit':
        fields.add('deposit')
    require(r.get('op') in ('credit', 'burn', 'transfer') and set(r) == fields, 'Invalid bridge record fields')
    require(r['p'] == 'xmr20' and type(r['v']) is int and (r['v'] == 1) and (r['net'] == 'mainnet'), 'Wrong mainnet bridge domain')
    require(isinstance(r['owner'], str) and len(r['owner']) == 95 and re.fullmatch('[0-9a-f]{32}', r['nonce'] or ''), 'Invalid owner or nonce')
    require(re.fullmatch('[0-9a-f]{64}', r['token'] or '') and isinstance(r['amount'], str) and re.fullmatch('[1-9][0-9]{0,14}', r['amount']) and (int(r['amount']) <= LIMIT), 'Invalid bridge amount')
    if r['op'] == 'credit':
        require(r['owner'] == c['address'] and len(r['to']) == 95 and re.fullmatch('[1-9A-HJ-NP-Za-km-z]{32,44}', r['deposit'] or ''), 'Invalid credit identity')
    elif r['op'] == 'transfer':
        require(isinstance(r['to'], str) and len(r['to']) == 95 and (r['to'] != r['owner']), 'Invalid transfer destination')
    else:
        require(re.fullmatch('[1-9A-HJ-NP-Za-km-z]{32,44}', r['to'] or ''), 'Invalid withdrawal destination')
    return r

def encode(c, e):
    require(type(e) is dict and set(e) == {'record', 'signature'}, 'Invalid bridge envelope')
    validate(c, e['record'])
    require(isinstance(e['signature'], str) and re.fullmatch('SigV2[1-9A-HJ-NP-Za-km-z]{80,110}', e['signature']), 'Invalid bridge signature')
    payload = carr.MAGIC + canonical(e).encode()
    require(len(payload) <= 800, 'Bridge carrier too large')
    return payload

def verified(c, e):
    encode(c, e)
    r = e['record']
    for address in {r['owner'], *([r['to']] if r['op'] in ('credit', 'transfer') else [])}:
        a = carr.wallet(c, 'validate_address', {'address': address, 'any_net_type': True, 'allow_openalias': False})
        if not (a.get('valid') and a.get('nettype') == 'mainnet' and (not a.get('subaddress')) and (not a.get('integrated'))):
            return False
    result = carr.wallet(c, 'verify', {'data': (launch.signing_domain(r) if r['op'] == 'deploy' else TRANSFER_DOMAIN if r['op'] == 'transfer' else DOMAIN) + canonical(r), 'address': r['owner'], 'signature': e['signature']})
    return result.get('good') is True and result.get('signature_type') == 'spend' and (result.get('version') == 2) and (result.get('old') is False)

def scan(c):
    """Replay all carrier events from a pinned start; never accept a partial scan."""
    carr.chain(c)
    urls = c['daemonUrls']
    heights = [carr.daemon(u, 'get_info')['height'] for u in urls]
    height = min(heights)
    if c.get('replayHeight') is not None:
        target = c['replayHeight']
        require(type(target) is int and c['bridgeStartHeight'] <= target < height, 'Replay checkpoint unavailable')
        height = target + 1
    tip = height - 1
    start = c['bridgeStartHeight']
    require(type(start) is int and 0 <= start <= tip, 'Invalid mainnet index range')
    path = scan_cache_path(c)
    cache = json.loads(path.read_text()) if path.exists() else {}

    def header(h):
        (a, b) = [carr.daemon(u, 'get_block_header_by_height', {'height': h})['block_header'] for u in urls]
        require(a['hash'] == b['hash'] and (not a.get('orphan_status')) and (not b.get('orphan_status')), 'Bridge index nodes disagree')
        return a
    initial = header(tip)
    for k in sorted(cache, key=int, reverse=True):
        if int(k) > tip:
            del cache[k]
            continue
        if header(int(k))['hash'] == cache[k]['hash']:
            break
        del cache[k]
    begin = max((int(k) for k in cache), default=start - 1) + 1
    previous = cache.get(str(begin - 1), {}).get('hash')
    for h in range(begin, min(tip + 1, begin + 12)):
        expected = header(h)
        b = carr.daemon(urls[0], 'get_block', {'height': h})
        bh = b['block_header']
        require(bh['hash'] == expected['hash'] and (previous is None or bh['prev_hash'] == previous), 'Mainnet index reorganized')
        events = []
        hashes = b.get('tx_hashes', [])
        for off in range(0, len(hashes), 50):
            batch = hashes[off:off + 50]
            res = carr.daemon(urls[0], None, {'txs_hashes': batch, 'decode_as_json': True, 'prune': True}, '/get_transactions')
            require(res.get('status') == 'OK' and (not res.get('missed_tx')) and (len(res.get('txs', [])) == len(batch)), 'Incomplete index block')
            byhash = {t['tx_hash']: t for t in res['txs']}
            require(set(byhash) == set(batch), 'Wrong indexed transactions')
            for (idx, txid) in enumerate(batch):
                tx = byhash[txid]
                require(not tx.get('in_pool') and tx['block_height'] == h, 'Wrong indexed block')
                try:
                    payload = carr.extract(json.loads(tx['as_json'])['extra'])
                    e = json.loads(payload[len(carr.MAGIC):])
                    require(encode(c, e) == payload, 'Noncanonical bridge record')
                except (ValueError, KeyError, TypeError, IndexError):
                    continue
                if e['record']['op'] == 'transfer' and (type(c.get('transferStartHeight')) is not int or h < c['transferStartHeight']):
                    continue
                if not verified(c, e):
                    continue
                peer = carr.daemon(urls[1], None, {'txs_hashes': [txid], 'decode_as_json': True, 'prune': True}, '/get_transactions')
                require(peer.get('status') == 'OK' and len(peer.get('txs', [])) == 1, 'Peer carrier unavailable')
                pt = peer['txs'][0]
                require(pt['tx_hash'] == txid and (not pt.get('in_pool')) and (pt['block_height'] == h) and (carr.extract(json.loads(pt['as_json'])['extra']) == payload), 'Mainnet carrier peers disagree')
                events.append({'txid': txid, 'height': h, 'index': off + idx, 'envelope': e})
        cache[str(h)] = {'hash': bh['hash'], 'parent': bh['prev_hash'], 'events': events}
        previous = bh['hash']
        atomic(path, cache)
    require(str(tip) in cache, 'Monero mainnet index is catching up. Retry shortly.')
    require(header(tip)['hash'] == initial['hash'], 'Mainnet index tip changed')
    events = []
    previous = None
    for h in range(start, tip + 1):
        block = cache[str(h)]
        require(previous is None or block['parent'] == previous, 'Broken mainnet index chain')
        previous = block['hash']
        events.extend([{**e, 'confirmations': height - e['height']} for e in block['events'] if height - e['height'] >= 10])
    return {'network': 'mainnet', 'height': tip, 'events': events}
