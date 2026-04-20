class OptionalDouble {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  value() {
    return this.bb.readFloat64(this.bb_pos);
  }
  hasValue() {
    return !!this.bb.readInt8(this.bb_pos + 8);
  }
  _Pad(index) {
    return this.bb.readUint8(this.bb_pos + 9 + index);
  }
  static sizeOf() {
    return 16;
  }
  static createOptionalDouble(builder, value, has_value, _pad) {
    builder.prep(8, 16);
    for (let i = 6; i >= 0; --i) {
      builder.writeInt8(_pad?.[i] ?? 0);
    }
    builder.writeInt8(Number(Boolean(has_value)));
    builder.writeFloat64(value);
    return builder.offset();
  }
  unpack() {
    return new OptionalDoubleT(
      this.value(),
      this.hasValue(),
      this.bb.createScalarList(this._Pad.bind(this), 7)
    );
  }
  unpackTo(_o) {
    _o.value = this.value();
    _o.hasValue = this.hasValue();
    _o._Pad = this.bb.createScalarList(this._Pad.bind(this), 7);
  }
}
class OptionalDoubleT {
  constructor(value = 0, hasValue = false, _Pad = []) {
    this.value = value;
    this.hasValue = hasValue;
    this._Pad = _Pad;
  }
  pack(builder) {
    return OptionalDouble.createOptionalDouble(
      builder,
      this.value,
      this.hasValue,
      this._Pad
    );
  }
}
export {
  OptionalDouble,
  OptionalDoubleT
};
