class Color8 {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  r() {
    return this.bb.readUint8(this.bb_pos);
  }
  g() {
    return this.bb.readUint8(this.bb_pos + 1);
  }
  b() {
    return this.bb.readUint8(this.bb_pos + 2);
  }
  a() {
    return this.bb.readUint8(this.bb_pos + 3);
  }
  static sizeOf() {
    return 4;
  }
  static createColor8(builder, r, g, b, a) {
    builder.prep(1, 4);
    builder.writeInt8(a);
    builder.writeInt8(b);
    builder.writeInt8(g);
    builder.writeInt8(r);
    return builder.offset();
  }
  unpack() {
    return new Color8T(
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
class Color8T {
  constructor(r = 0, g = 0, b = 0, a = 0) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }
  pack(builder) {
    return Color8.createColor8(
      builder,
      this.r,
      this.g,
      this.b,
      this.a
    );
  }
}
export {
  Color8,
  Color8T
};
