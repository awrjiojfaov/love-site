# -*- coding: utf-8 -*-
"""TC3 签名调用腾讯云 EdgeOne(teo) API，查域名状态"""
import hashlib, hmac, json, time, os, sys
from urllib.request import Request, urlopen

def load_env(p):
    env = {}
    with open(p, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    return env

creds = load_env(os.environ.get('TEO_CREDS', os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'deploy', 'tencent-credentials.env')))
SID, SKEY = creds['TENCENT_SECRET_ID'], creds['TENCENT_SECRET_KEY']

def call(action, params, version='2022-09-01'):
    service = 'teo'
    host = 'teo.tencentcloudapi.com'
    payload = json.dumps(params)
    t = int(time.time())
    date = time.strftime('%Y-%m-%d', time.gmtime(t))
    ct = 'application/json; charset=utf-8'
    canonical_headers = f'content-type:{ct}\nhost:{host}\n'
    signed_headers = 'content-type;host'
    hashed_payload = hashlib.sha256(payload.encode()).hexdigest()
    canonical_request = f'POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}'
    credential_scope = f'{date}/{service}/tc3_request'
    string_to_sign = f'TC3-HMAC-SHA256\n{t}\n{credential_scope}\n{hashlib.sha256(canonical_request.encode()).hexdigest()}'
    def sign(key, msg):
        return hmac.new(key, msg.encode(), hashlib.sha256).digest()
    secret_date = sign(('TC3' + SKEY).encode(), date)
    secret_service = sign(secret_date, service)
    secret_signing = sign(secret_service, 'tc3_request')
    signature = hmac.new(secret_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()
    authorization = (f'TC3-HMAC-SHA256 Credential={SID}/{credential_scope}, '
                     f'SignedHeaders={signed_headers}, Signature={signature}')
    req = Request(f'https://{host}/', data=payload.encode(), method='POST', headers={
        'Authorization': authorization, 'Content-Type': ct, 'Host': host,
        'X-TC-Action': action, 'X-TC-Timestamp': str(t), 'X-TC-Version': version,
    })
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read())

action = sys.argv[1] if len(sys.argv) > 1 else 'DescribeZones'
params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
print(json.dumps(call(action, params), ensure_ascii=False, indent=1)[:4000])
