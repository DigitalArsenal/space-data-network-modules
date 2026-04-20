class Vec3f {
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
  z() {
    return this.bb.readFloat32(this.bb_pos + 8);
  }
  static sizeOf() {
    return 12;
  }
  static createVec3f(builder, x, y, z) {
    builder.prep(4, 12);
    builder.writeFloat32(z);
    builder.writeFloat32(y);
    builder.writeFloat32(x);
    return builder.offset();
  }
  unpack() {
    return new Vec3fT(
      this.x(),
      this.y(),
      this.z()
    );
  }
  unpackTo(_o) {
    _o.x = this.x();
    _o.y = this.y();
    _o.z = this.z();
  }
}
class Vec3fT {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  pack(builder) {
    return Vec3f.createVec3f(
      builder,
      this.x,
      this.y,
      this.z
    );
  }
}
export {
  Vec3f,
  Vec3fT
};
