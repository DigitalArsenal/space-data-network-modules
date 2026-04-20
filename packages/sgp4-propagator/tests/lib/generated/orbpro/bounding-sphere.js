import { Vec3 } from "./vec3.js";
class BoundingSphere {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  center(obj) {
    return (obj || new Vec3()).__init(this.bb_pos, this.bb);
  }
  radius() {
    return this.bb.readFloat64(this.bb_pos + 24);
  }
  static sizeOf() {
    return 32;
  }
  static createBoundingSphere(builder, center_x, center_y, center_z, radius) {
    builder.prep(8, 32);
    builder.writeFloat64(radius);
    builder.prep(8, 24);
    builder.writeFloat64(center_z);
    builder.writeFloat64(center_y);
    builder.writeFloat64(center_x);
    return builder.offset();
  }
  unpack() {
    return new BoundingSphereT(
      this.center() !== null ? this.center().unpack() : null,
      this.radius()
    );
  }
  unpackTo(_o) {
    _o.center = this.center() !== null ? this.center().unpack() : null;
    _o.radius = this.radius();
  }
}
class BoundingSphereT {
  constructor(center = null, radius = 0) {
    this.center = center;
    this.radius = radius;
  }
  pack(builder) {
    return BoundingSphere.createBoundingSphere(
      builder,
      this.center?.x ?? 0,
      this.center?.y ?? 0,
      this.center?.z ?? 0,
      this.radius
    );
  }
}
export {
  BoundingSphere,
  BoundingSphereT
};
