class TimeInterval {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  start() {
    return this.bb.readFloat64(this.bb_pos);
  }
  stop() {
    return this.bb.readFloat64(this.bb_pos + 8);
  }
  static sizeOf() {
    return 16;
  }
  static createTimeInterval(builder, start, stop) {
    builder.prep(8, 16);
    builder.writeFloat64(stop);
    builder.writeFloat64(start);
    return builder.offset();
  }
  unpack() {
    return new TimeIntervalT(
      this.start(),
      this.stop()
    );
  }
  unpackTo(_o) {
    _o.start = this.start();
    _o.stop = this.stop();
  }
}
class TimeIntervalT {
  constructor(start = 0, stop = 0) {
    this.start = start;
    this.stop = stop;
  }
  pack(builder) {
    return TimeInterval.createTimeInterval(
      builder,
      this.start,
      this.stop
    );
  }
}
export {
  TimeInterval,
  TimeIntervalT
};
