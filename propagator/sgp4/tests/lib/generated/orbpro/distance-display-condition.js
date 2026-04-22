class DistanceDisplayCondition {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  near() {
    return this.bb.readFloat64(this.bb_pos);
  }
  far() {
    return this.bb.readFloat64(this.bb_pos + 8);
  }
  static sizeOf() {
    return 16;
  }
  static createDistanceDisplayCondition(builder, near, far) {
    builder.prep(8, 16);
    builder.writeFloat64(far);
    builder.writeFloat64(near);
    return builder.offset();
  }
  unpack() {
    return new DistanceDisplayConditionT(
      this.near(),
      this.far()
    );
  }
  unpackTo(_o) {
    _o.near = this.near();
    _o.far = this.far();
  }
}
class DistanceDisplayConditionT {
  constructor(near = 0, far = 0) {
    this.near = near;
    this.far = far;
  }
  pack(builder) {
    return DistanceDisplayCondition.createDistanceDisplayCondition(
      builder,
      this.near,
      this.far
    );
  }
}
export {
  DistanceDisplayCondition,
  DistanceDisplayConditionT
};
