import { Vec3 } from "./vec3.js";
class BoundingBox {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  min(obj) {
    return (obj || new Vec3()).__init(this.bb_pos, this.bb);
  }
  max(obj) {
    return (obj || new Vec3()).__init(this.bb_pos + 24, this.bb);
  }
  static sizeOf() {
    return 48;
  }
  static createBoundingBox(builder, min_x, min_y, min_z, max_x, max_y, max_z) {
    builder.prep(8, 48);
    builder.prep(8, 24);
    builder.writeFloat64(max_z);
    builder.writeFloat64(max_y);
    builder.writeFloat64(max_x);
    builder.prep(8, 24);
    builder.writeFloat64(min_z);
    builder.writeFloat64(min_y);
    builder.writeFloat64(min_x);
    return builder.offset();
  }
  unpack() {
    return new BoundingBoxT(
      this.min() !== null ? this.min().unpack() : null,
      this.max() !== null ? this.max().unpack() : null
    );
  }
  unpackTo(_o) {
    _o.min = this.min() !== null ? this.min().unpack() : null;
    _o.max = this.max() !== null ? this.max().unpack() : null;
  }
}
class BoundingBoxT {
  constructor(min = null, max = null) {
    this.min = min;
    this.max = max;
  }
  pack(builder) {
    return BoundingBox.createBoundingBox(
      builder,
      this.min?.x ?? 0,
      this.min?.y ?? 0,
      this.min?.z ?? 0,
      this.max?.x ?? 0,
      this.max?.y ?? 0,
      this.max?.z ?? 0
    );
  }
}
export {
  BoundingBox,
  BoundingBoxT
};
