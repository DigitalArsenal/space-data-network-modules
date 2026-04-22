class Vec2 {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  x() {
    return this.bb.readFloat64(this.bb_pos);
  }
  y() {
    return this.bb.readFloat64(this.bb_pos + 8);
  }
  static sizeOf() {
    return 16;
  }
  static createVec2(builder, x, y) {
    builder.prep(8, 16);
    builder.writeFloat64(y);
    builder.writeFloat64(x);
    return builder.offset();
  }
  unpack() {
    return new Vec2T(
      this.x(),
      this.y()
    );
  }
  unpackTo(_o) {
    _o.x = this.x();
    _o.y = this.y();
  }
}
class Vec2T {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  pack(builder) {
    return Vec2.createVec2(
      builder,
      this.x,
      this.y
    );
  }
}
export {
  Vec2,
  Vec2T
};
