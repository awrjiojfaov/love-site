#!/usr/bin/env python3
"""预生成打卡地图数据：从阿里云 DataV 拉 GeoJSON，投影成 SVG path，输出到 public/geo/{adcode}.json"""
import json, math, os, urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'geo')
os.makedirs(OUT, exist_ok=True)

def fetch(adcode):
    url = f'https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json'
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)['features']

def project(raw, clip_adcode=None, inset_box=None):
    """投影。clip_adcode: 该 feature 不参与包围盒计算（如十段线）；inset_box=(x,y,w,h) 把它重定位进插图框"""
    min_lon, max_lon, min_lat, max_lat = 180, -180, 90, -90
    def scan(lon, lat):
        nonlocal min_lon, max_lon, min_lat, max_lat
        min_lon = min(min_lon, lon); max_lon = max(max_lon, lon)
        min_lat = min(min_lat, lat); max_lat = max(max_lat, lat)
    for f in raw:
        g = f.get('geometry')
        if not g or f['properties'].get('adcode') == clip_adcode: continue
        polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
        for poly in polys:
            for ring in poly:
                for lon, lat in ring:
                    scan(lon, lat)
    W = 1000
    lon_span = (max_lon - min_lon) or 1
    lat_span = (max_lat - min_lat) or 1
    s = W / lon_span
    H = round(lat_span * s)
    px = lambda lon: (lon - min_lon) * s
    py = lambda lat: (max_lat - lat) * s

    # 先算被裁剪 feature 的投影包围盒，用于插图重定位
    ix = iy = None
    if clip_adcode and inset_box:
        pts = []
        for f in raw:
            if f['properties'].get('adcode') != clip_adcode or not f.get('geometry'): continue
            g = f['geometry']
            polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
            for poly in polys:
                for ring in poly:
                    pts.extend(ring)
        jx0 = min(px(l) for l, _ in pts); jx1 = max(px(l) for l, _ in pts)
        jy0 = min(py(t) for _, t in pts); jy1 = max(py(t) for _, t in pts)
        bx, by, bw, bh = inset_box
        k = min(bw / (jx1 - jx0 or 1), bh / (jy1 - jy0 or 1))
        ix = (bx, by, bw, bh, k, jx0, jy0)

    def path_of(f):
        g = f['geometry']
        polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
        clipped = f['properties'].get('adcode') == clip_adcode and ix
        parts = []
        for poly in polys:
            for ring in poly:
                cmds = []
                for i, (lon, lat) in enumerate(ring):
                    X, Y = px(lon), py(lat)
                    if clipped:
                        bx, by, bw, bh, k, jx0, jy0 = ix
                        X = (X - jx0) * k + bx
                        Y = (Y - jy0) * k + by
                    cmds.append(('M' if i == 0 else 'L') + f'{round(X,1)},{round(Y,1)}')
                parts.append(''.join(cmds) + 'Z')
        return ''.join(parts)

    feats = []
    for f in raw:
        if not f.get('geometry'): continue
        p = f['properties']
        c = p.get('centroid') or p.get('center') or [(min_lon + max_lon) / 2, (min_lat + max_lat) / 2]
        feats.append({'adcode': p['adcode'], 'name': p['name'],
                      'path': path_of(f), 'label': [round(px(c[0]),1), round(py(c[1]),1)]})
    out = {'features': feats, 'viewBox': f'0 0 {W} {H}', 'width': W, 'height': H}
    if ix:
        out['inset'] = {'x': ix[0], 'y': ix[1], 'w': ix[2], 'h': ix[3]}
    return out

def save(adcode, data):
    path = os.path.join(OUT, f'{adcode}.json')
    with open(path, 'w', encoding='utf-8') as fp:
        json.dump(data, fp, ensure_ascii=False, separators=(',', ':'))
    print(f'{adcode}: {len(data["features"])} 个板块, {os.path.getsize(path)//1024}KB')

china_raw = fetch(100000)
# 十段线（100000_JD）不参与包围盒；先算一次拿 H，再把十段线重定位为右下角插图
H = project(china_raw, clip_adcode='100000_JD')['height']
china = project(china_raw, clip_adcode='100000_JD', inset_box=(862, H - 168, 128, 152))
save(100000, china)
prov_codes = [f['properties']['adcode'] for f in china_raw]
print(f'共 {len(prov_codes)} 个省级板块')
for code in prov_codes:
    try:
        save(code, project(fetch(code)))
    except Exception as e:
        print(f'{code}: 失败 {e}')
print('完成')
