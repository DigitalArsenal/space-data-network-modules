import { Vec3 } from "../vec3.js";
import { ReferenceFrame } from "./reference-frame.js";
class StateVector {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  /**
   * Julian date of this state
   */
  epoch() {
    return this.bb.readFloat64(this.bb_pos);
  }
  /**
   * Position [x, y, z] in km (reference frame specified below)
   */
  position(obj) {
    return (obj || new Vec3()).__init(this.bb_pos + 8, this.bb);
  }
  /**
   * Velocity [vx, vy, vz] in km/s
   */
  velocity(obj) {
    return (obj || new Vec3()).__init(this.bb_pos + 32, this.bb);
  }
  /**
   * Reference frame for position/velocity
   */
  referenceFrame() {
    return this.bb.readUint8(this.bb_pos + 56);
  }
  /**
   * Reserved padding for alignment
   */
  _Reserved(index) {
    return this.bb.readUint8(this.bb_pos + 57 + index);
  }
  /**
   * Status flags (StateFlags bitfield)
   */
  flags() {
    return this.bb.readUint32(this.bb_pos + 60);
  }
  static sizeOf() {
    return 64;
  }
  static createStateVector(builder, epoch, position_x, position_y, position_z, velocity_x, velocity_y, velocity_z, reference_frame, _reserved, flags) {
    builder.prep(8, 64);
    builder.writeInt32(flags);
    for (let i = 2; i >= 0; --i) {
      builder.writeInt8(_reserved?.[i] ?? 0);
    }
    builder.writeInt8(reference_frame);
    builder.prep(8, 24);
    builder.writeFloat64(velocity_z);
    builder.writeFloat64(velocity_y);
    builder.writeFloat64(velocity_x);
    builder.prep(8, 24);
    builder.writeFloat64(position_z);
    builder.writeFloat64(position_y);
    builder.writeFloat64(position_x);
    builder.writeFloat64(epoch);
    return builder.offset();
  }
  unpack() {
    return new StateVectorT(
      this.epoch(),
      this.position() !== null ? this.position().unpack() : null,
      this.velocity() !== null ? this.velocity().unpack() : null,
      this.referenceFrame(),
      this.bb.createScalarList(this._Reserved.bind(this), 3),
      this.flags()
    );
  }
  unpackTo(_o) {
    _o.epoch = this.epoch();
    _o.position = this.position() !== null ? this.position().unpack() : null;
    _o.velocity = this.velocity() !== null ? this.velocity().unpack() : null;
    _o.referenceFrame = this.referenceFrame();
    _o._Reserved = this.bb.createScalarList(this._Reserved.bind(this), 3);
    _o.flags = this.flags();
  }
}
class StateVectorT {
  constructor(epoch = 0, position = null, velocity = null, referenceFrame = ReferenceFrame.TEME, _Reserved = [], flags = 0) {
    this.epoch = epoch;
    this.position = position;
    this.velocity = velocity;
    this.referenceFrame = referenceFrame;
    this._Reserved = _Reserved;
    this.flags = flags;
  }
  pack(builder) {
    return StateVector.createStateVector(
      builder,
      this.epoch,
      this.position?.x ?? 0,
      this.position?.y ?? 0,
      this.position?.z ?? 0,
      this.velocity?.x ?? 0,
      this.velocity?.y ?? 0,
      this.velocity?.z ?? 0,
      this.referenceFrame,
      this._Reserved,
      this.flags
    );
  }
}
export {
  StateVector,
  StateVectorT
};
