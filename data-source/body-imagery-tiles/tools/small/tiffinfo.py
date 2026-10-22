import struct, sys, json
def info(path):
    f = open(path,'rb'); h = f.read(16)
    bo = '<' if h[:2]==b'II' else '>'
    ver = struct.unpack(bo+'H', h[2:4])[0]
    big = ver==43
    if big: off = struct.unpack(bo+'Q', h[8:16])[0]
    else: off = struct.unpack(bo+'I', h[4:8])[0]
    f.seek(off)
    n = struct.unpack(bo+('Q' if big else 'H'), f.read(8 if big else 2))[0]
    tags={}
    sz = 20 if big else 12
    for i in range(n):
        e = f.read(sz)
        if big: tag,typ,cnt = struct.unpack(bo+'HHQ', e[:12]); val=e[12:]
        else: tag,typ,cnt = struct.unpack(bo+'HHI', e[:8]); val=e[8:]
        tsz = {1:1,2:1,3:2,4:4,5:8,8:2,9:4,11:4,12:8,16:8}[typ]
        fmt = {1:'B',2:'c',3:'H',4:'I',8:'h',9:'i',11:'f',12:'d',16:'Q'}.get(typ,'B')
        total = tsz*cnt
        if total <= (8 if big else 4): raw = val[:total]
        else:
            ofs = struct.unpack(bo+('Q' if big else 'I'), val[:8 if big else 4])[0]
            pos=f.tell(); f.seek(ofs); raw=f.read(total); f.seek(pos)
        if typ==2: tags[tag]=raw.decode('latin1').rstrip('\0')
        elif typ in (5,10): tags[tag]=raw
        else: tags[tag]=list(struct.unpack(bo+fmt*cnt, raw))
    return tags
if __name__=='__main__':
    for p in sys.argv[1:]:
        t=info(p)
        W=t[256][0];H=t[257][0]; so=t.get(273); bc=t.get(279)
        rps=t.get(278,[H])[0]; comp=t.get(259,[1])[0]; spp=t.get(277,[1])[0]; bps=t.get(258); planar=t.get(284,[1])[0]
        contig = so is not None and all(so[i]==so[0]+i*rps*W*spp*(bps[0]//8) for i in range(len(so))) if spp==1 else None
        print(p.split('/')[-1], dict(W=W,H=H,spp=spp,bps=bps,comp=comp,rps=rps,planar=planar,nstrips=len(so) if so else None,strip0=so[0] if so else None,contig=contig, tiled=273 not in t or 322 in t))
