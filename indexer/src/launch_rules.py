DOMAIN = 'MOUSE-ROAD-XMR20-MAINNET-DEPLOY-V1\n'

def signing_domain(record):
    return 'XMR20-MAINNET-DEPLOY-V2\n' if record['v'] == 2 else DOMAIN

def validate_record(c, r):
    fields = {'p', 'v', 'net', 'op', 'owner', 'nonce', 'tick', 'mint', 'creator', 'chain', 'max', 'initial', 'fee', 'meta'}
    require(type(r) is dict and set(r) == fields, 'Invalid mainnet deployment record')
    require(r['p'] == 'xmr20' and type(r['v']) is int and (r['v'] in (1, 2)) and (r['net'] == 'mainnet') and (r['op'] == 'deploy'), 'Wrong mainnet deployment domain')
    require(r['owner'] == c['address'] and isinstance(r['tick'], str) and re.fullmatch('[A-Z][A-Z0-9]{0,9}', r['tick']) and (r['chain'] == ('mainnet' if r['v'] == 2 else 'mainnet-beta')), 'Wrong mainnet launch identity')
    require(r['max'] == '1000000000000000' and r['initial'] == '0' and (r['fee'] in ('200', '150')), 'Invalid fixed-supply mainnet policy')
    require(re.fullmatch('[0-9a-f]{32}', r['nonce']) and re.fullmatch('[0-9a-f]{64}', r['meta']), 'Invalid deployment commitment')
    for name in ('mint', 'creator'):
        require(isinstance(r[name], str) and re.fullmatch('[1-9A-HJ-NP-Za-km-z]{32,44}', r[name]), 'Invalid Solana identity')
    return r
