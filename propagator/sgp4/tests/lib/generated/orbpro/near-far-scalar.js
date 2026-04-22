class NearFarScalar {
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
  nearValue() {
    return this.bb.readFloat64(this.bb_pos + 8);
  }
  far() {
    return this.bb.readFloat64(this.bb_pos + 16);
  }
  farValue() {
    return this.bb.readFloat64(this.bb_pos + 24);
  }
  static sizeOf() {
    return 32;
  }
  static createNearFarScalar(builder, near, near_value, far, far_value) {
    builder.prep(8, 32);
    builder.writeFloat64(far_value);
    builder.writeFloat64(far);
    builder.writeFloat64(near_value);
    builder.writeFloat64(near);
    return builder.offset();
  }
  unpack() {
    return new NearFarScalarT(
      this.near(),
      this.nearValue(),
      this.far(),
      this.farValue()
    );
  }
  unpackTo(_o) {
    _o.near = this.near();
    _o.nearValue = this.nearValue();
    _o.far = this.far();
    _o.farValue = this.farValue();
  }
}
class NearFarScalarT {
  constructor(near = 0, nearValue = 0, far = 0, farValue = 0) {
    this.near = near;
    this.nearValue = nearValue;
    this.far = far;
    this.farValue = farValue;
  }
  pack(builder) {
    return NearFarScalar.createNearFarScalar(
      builder,
      this.near,
      this.nearValue,
      this.far,
      this.farValue
    );
  }
}
export {
  NearFarScalar,
  NearFarScalarT
};
