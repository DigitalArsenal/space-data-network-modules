class Colorf {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  r() {
    return this.bb.readFloat32(this.bb_pos);
  }
  g() {
    return this.bb.readFloat32(this.bb_pos + 4);
  }
  b() {
    return this.bb.readFloat32(this.bb_pos + 8);
  }
  a() {
    return this.bb.readFloat32(this.bb_pos + 12);
  }
  static sizeOf() {
    return 16;
  }
  static createColorf(builder, r, g, b, a) {
    builder.prep(4, 16);
    builder.writeFloat32(a);
    builder.writeFloat32(b);
    builder.writeFloat32(g);
    builder.writeFloat32(r);
    return builder.offset();
  }
  unpack() {
    return new ColorfT(
      this.r(),
      this.g(),
      this.b(),
      this.a()
    );
  }
  unpackTo(_o) {
    _o.r = this.r();
    _o.g = this.g();
    _o.b = this.b();
    _o.a = this.a();
  }
}
class ColorfT {
  constructor(r = 0, g = 0, b = 0, a = 0) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }
  pack(builder) {
    return Colorf.createColorf(
      builder,
      this.r,
      this.g,
      this.b,
      this.a
    );
  }
}
export {
  Colorf,
  ColorfT
};
