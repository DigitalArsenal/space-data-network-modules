class Vec2f {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  x() {
    return this.bb.readFloat32(this.bb_pos);
  }
  y() {
    return this.bb.readFloat32(this.bb_pos + 4);
  }
  static sizeOf() {
    return 8;
  }
  static createVec2f(builder, x, y) {
    builder.prep(4, 8);
    builder.writeFloat32(y);
    builder.writeFloat32(x);
    return builder.offset();
  }
  unpack() {
    return new Vec2fT(
      this.x(),
      this.y()
    );
  }
  unpackTo(_o) {
    _o.x = this.x();
    _o.y = this.y();
  }
}
class Vec2fT {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  pack(builder) {
    return Vec2f.createVec2f(
      builder,
      this.x,
      this.y
    );
  }
}
export {
  Vec2f,
  Vec2fT
};
