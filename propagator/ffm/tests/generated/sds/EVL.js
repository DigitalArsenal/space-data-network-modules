import * as flatbuffers from 'flatbuffers';
import { EVLEventLocationRequest, EVLEventLocationRequestT } from './EVLEventLocationRequest.js';
import { EVLEventReport, EVLEventReportT } from './EVLEventReport.js';
export class EVL {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsEVL(bb, obj) {
        return (obj || new EVL()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsEVL(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new EVL()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    LOCATION_REQUEST(obj) {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? (obj || new EVLEventLocationRequest()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    EVENT_REPORT(obj) {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? (obj || new EVLEventReport()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    static startEVL(builder) {
        builder.startObject(2);
    }
    static addLocationRequest(builder, LOCATION_REQUESTOffset) {
        builder.addFieldOffset(0, LOCATION_REQUESTOffset, 0);
    }
    static addEventReport(builder, EVENT_REPORTOffset) {
        builder.addFieldOffset(1, EVENT_REPORTOffset, 0);
    }
    static endEVL(builder) {
        const offset = builder.endObject();
        return offset;
    }
    unpack() {
        return new EVLT(this.LOCATION_REQUEST() !== null ? this.LOCATION_REQUEST().unpack() : null, this.EVENT_REPORT() !== null ? this.EVENT_REPORT().unpack() : null);
    }
    unpackTo(_o) {
        _o.LOCATION_REQUEST = this.LOCATION_REQUEST() !== null ? this.LOCATION_REQUEST().unpack() : null;
        _o.EVENT_REPORT = this.EVENT_REPORT() !== null ? this.EVENT_REPORT().unpack() : null;
    }
}
export class EVLT {
    LOCATION_REQUEST;
    EVENT_REPORT;
    constructor(LOCATION_REQUEST = null, EVENT_REPORT = null){
        this.LOCATION_REQUEST = LOCATION_REQUEST;
        this.EVENT_REPORT = EVENT_REPORT;
    }
    pack(builder) {
        const LOCATION_REQUEST = this.LOCATION_REQUEST !== null ? this.LOCATION_REQUEST.pack(builder) : 0;
        const EVENT_REPORT = this.EVENT_REPORT !== null ? this.EVENT_REPORT.pack(builder) : 0;
        EVL.startEVL(builder);
        EVL.addLocationRequest(builder, LOCATION_REQUEST);
        EVL.addEventReport(builder, EVENT_REPORT);
        return EVL.endEVL(builder);
    }
}
