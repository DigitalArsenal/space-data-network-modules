class BoundingRectangle {
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
  width() {
    return this.bb.readFloat64(this.bb_pos + 16);
  }
  height() {
    return this.bb.readFloat64(this.bb_pos + 24);
  }
  static sizeOf() {
    return 32;
  }
  static createBoundingRectangle(builder, x, y, width, height) {
    builder.prep(8, 32);
    builder.writeFloat64(height);
    builder.writeFloat64(width);
    builder.writeFloat64(y);
    builder.writeFloat64(x);
    return builder.offset();
  }
  unpack() {
    return new BoundingRectangleT(
      this.x(),
      this.y(),
      this.width(),
      this.height()
    );
  }
  unpackTo(_o) {
    _o.x = this.x();
    _o.y = this.y();
    _o.width = this.width();
    _o.height = this.height();
  }
}
class BoundingRectangleT {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
  pack(builder) {
    return BoundingRectangle.createBoundingRectangle(
      builder,
      this.x,
      this.y,
      this.width,
      this.height
    );
  }
}
export {
  BoundingRectangle,
  BoundingRectangleT
};
