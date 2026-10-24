import * as flatbuffers from 'flatbuffers';
import { PCFEventDefinition, PCFEventDefinitionT } from './PCFEventDefinition.js';
import { PCFFitPolicy, PCFFitPolicyT } from './PCFFitPolicy.js';
import { PCFForceModel, PCFForceModelT } from './PCFForceModel.js';
import { PCFIntegratorSettings, PCFIntegratorSettingsT } from './PCFIntegratorSettings.js';
import { PCFLaunch, PCFLaunchT } from './PCFLaunch.js';
import { PCFManeuverDetection, PCFManeuverDetectionT } from './PCFManeuverDetection.js';
import { PCFMeanElementOptions, PCFMeanElementOptionsT } from './PCFMeanElementOptions.js';
import { PCFOutput, PCFOutputT } from './PCFOutput.js';
import { PCFReentry, PCFReentryT } from './PCFReentry.js';
import { PCFSegmentOptions, PCFSegmentOptionsT } from './PCFSegmentOptions.js';
import { pcfTheory } from './pcfTheory.js';
export class PCF {
    bb = null;
    bb_pos = 0;
    __init(i, bb) {
        this.bb_pos = i;
        this.bb = bb;
        return this;
    }
    static getRootAsPCF(bb, obj) {
        return (obj || new PCF()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    static getSizePrefixedRootAsPCF(bb, obj) {
        bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
        return (obj || new PCF()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
    }
    CONFIGURATION_ID(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 4);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    PROFILE(optionalEncoding) {
        const offset = this.bb.__offset(this.bb_pos, 6);
        return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
    }
    THEORY() {
        const offset = this.bb.__offset(this.bb_pos, 8);
        return offset ? this.bb.readUint8(this.bb_pos + offset) : pcfTheory.UNSPECIFIED;
    }
    INTEGRATOR(obj) {
        const offset = this.bb.__offset(this.bb_pos, 10);
        return offset ? (obj || new PCFIntegratorSettings()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    FORCES(obj) {
        const offset = this.bb.__offset(this.bb_pos, 12);
        return offset ? (obj || new PCFForceModel()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    MEAN_ELEMENT(obj) {
        const offset = this.bb.__offset(this.bb_pos, 14);
        return offset ? (obj || new PCFMeanElementOptions()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    SEGMENTS(obj) {
        const offset = this.bb.__offset(this.bb_pos, 16);
        return offset ? (obj || new PCFSegmentOptions()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    FIT(obj) {
        const offset = this.bb.__offset(this.bb_pos, 18);
        return offset ? (obj || new PCFFitPolicy()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    EVENTS(index, obj) {
        const offset = this.bb.__offset(this.bb_pos, 20);
        return offset ? (obj || new PCFEventDefinition()).__init(this.bb.__indirect(this.bb.__vector(this.bb_pos + offset) + index * 4), this.bb) : null;
    }
    eventsLength() {
        const offset = this.bb.__offset(this.bb_pos, 20);
        return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
    }
    MANEUVER_DETECTION(obj) {
        const offset = this.bb.__offset(this.bb_pos, 22);
        return offset ? (obj || new PCFManeuverDetection()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    REENTRY(obj) {
        const offset = this.bb.__offset(this.bb_pos, 24);
        return offset ? (obj || new PCFReentry()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    LAUNCH(obj) {
        const offset = this.bb.__offset(this.bb_pos, 26);
        return offset ? (obj || new PCFLaunch()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    OUTPUT(obj) {
        const offset = this.bb.__offset(this.bb_pos, 28);
        return offset ? (obj || new PCFOutput()).__init(this.bb.__indirect(this.bb_pos + offset), this.bb) : null;
    }
    static startPCF(builder) {
        builder.startObject(13);
    }
    static addConfigurationId(builder, CONFIGURATION_IDOffset) {
        builder.addFieldOffset(0, CONFIGURATION_IDOffset, 0);
    }
    static addProfile(builder, PROFILEOffset) {
        builder.addFieldOffset(1, PROFILEOffset, 0);
    }
    static addTheory(builder, THEORY) {
        builder.addFieldInt8(2, THEORY, pcfTheory.UNSPECIFIED);
    }
    static addIntegrator(builder, INTEGRATOROffset) {
        builder.addFieldOffset(3, INTEGRATOROffset, 0);
    }
    static addForces(builder, FORCESOffset) {
        builder.addFieldOffset(4, FORCESOffset, 0);
    }
    static addMeanElement(builder, MEAN_ELEMENTOffset) {
        builder.addFieldOffset(5, MEAN_ELEMENTOffset, 0);
    }
    static addSegments(builder, SEGMENTSOffset) {
        builder.addFieldOffset(6, SEGMENTSOffset, 0);
    }
    static addFit(builder, FITOffset) {
        builder.addFieldOffset(7, FITOffset, 0);
    }
    static addEvents(builder, EVENTSOffset) {
        builder.addFieldOffset(8, EVENTSOffset, 0);
    }
    static createEventsVector(builder, data) {
        builder.startVector(4, data.length, 4);
        for(let i = data.length - 1; i >= 0; i--){
            builder.addOffset(data[i]);
        }
        return builder.endVector();
    }
    static startEventsVector(builder, numElems) {
        builder.startVector(4, numElems, 4);
    }
    static addManeuverDetection(builder, MANEUVER_DETECTIONOffset) {
        builder.addFieldOffset(9, MANEUVER_DETECTIONOffset, 0);
    }
    static addReentry(builder, REENTRYOffset) {
        builder.addFieldOffset(10, REENTRYOffset, 0);
    }
    static addLaunch(builder, LAUNCHOffset) {
        builder.addFieldOffset(11, LAUNCHOffset, 0);
    }
    static addOutput(builder, OUTPUTOffset) {
        builder.addFieldOffset(12, OUTPUTOffset, 0);
    }
    static endPCF(builder) {
        const offset = builder.endObject();
        return offset;
    }
    unpack() {
        return new PCFT(this.CONFIGURATION_ID(), this.PROFILE(), this.THEORY(), this.INTEGRATOR() !== null ? this.INTEGRATOR().unpack() : null, this.FORCES() !== null ? this.FORCES().unpack() : null, this.MEAN_ELEMENT() !== null ? this.MEAN_ELEMENT().unpack() : null, this.SEGMENTS() !== null ? this.SEGMENTS().unpack() : null, this.FIT() !== null ? this.FIT().unpack() : null, this.bb.createObjList(this.EVENTS.bind(this), this.eventsLength()), this.MANEUVER_DETECTION() !== null ? this.MANEUVER_DETECTION().unpack() : null, this.REENTRY() !== null ? this.REENTRY().unpack() : null, this.LAUNCH() !== null ? this.LAUNCH().unpack() : null, this.OUTPUT() !== null ? this.OUTPUT().unpack() : null);
    }
    unpackTo(_o) {
        _o.CONFIGURATION_ID = this.CONFIGURATION_ID();
        _o.PROFILE = this.PROFILE();
        _o.THEORY = this.THEORY();
        _o.INTEGRATOR = this.INTEGRATOR() !== null ? this.INTEGRATOR().unpack() : null;
        _o.FORCES = this.FORCES() !== null ? this.FORCES().unpack() : null;
        _o.MEAN_ELEMENT = this.MEAN_ELEMENT() !== null ? this.MEAN_ELEMENT().unpack() : null;
        _o.SEGMENTS = this.SEGMENTS() !== null ? this.SEGMENTS().unpack() : null;
        _o.FIT = this.FIT() !== null ? this.FIT().unpack() : null;
        _o.EVENTS = this.bb.createObjList(this.EVENTS.bind(this), this.eventsLength());
        _o.MANEUVER_DETECTION = this.MANEUVER_DETECTION() !== null ? this.MANEUVER_DETECTION().unpack() : null;
        _o.REENTRY = this.REENTRY() !== null ? this.REENTRY().unpack() : null;
        _o.LAUNCH = this.LAUNCH() !== null ? this.LAUNCH().unpack() : null;
        _o.OUTPUT = this.OUTPUT() !== null ? this.OUTPUT().unpack() : null;
    }
}
export class PCFT {
    CONFIGURATION_ID;
    PROFILE;
    THEORY;
    INTEGRATOR;
    FORCES;
    MEAN_ELEMENT;
    SEGMENTS;
    FIT;
    EVENTS;
    MANEUVER_DETECTION;
    REENTRY;
    LAUNCH;
    OUTPUT;
    constructor(CONFIGURATION_ID = null, PROFILE = null, THEORY = pcfTheory.UNSPECIFIED, INTEGRATOR = null, FORCES = null, MEAN_ELEMENT = null, SEGMENTS = null, FIT = null, EVENTS = [], MANEUVER_DETECTION = null, REENTRY = null, LAUNCH = null, OUTPUT = null){
        this.CONFIGURATION_ID = CONFIGURATION_ID;
        this.PROFILE = PROFILE;
        this.THEORY = THEORY;
        this.INTEGRATOR = INTEGRATOR;
        this.FORCES = FORCES;
        this.MEAN_ELEMENT = MEAN_ELEMENT;
        this.SEGMENTS = SEGMENTS;
        this.FIT = FIT;
        this.EVENTS = EVENTS;
        this.MANEUVER_DETECTION = MANEUVER_DETECTION;
        this.REENTRY = REENTRY;
        this.LAUNCH = LAUNCH;
        this.OUTPUT = OUTPUT;
    }
    pack(builder) {
        const CONFIGURATION_ID = this.CONFIGURATION_ID !== null ? builder.createString(this.CONFIGURATION_ID) : 0;
        const PROFILE = this.PROFILE !== null ? builder.createString(this.PROFILE) : 0;
        const INTEGRATOR = this.INTEGRATOR !== null ? this.INTEGRATOR.pack(builder) : 0;
        const FORCES = this.FORCES !== null ? this.FORCES.pack(builder) : 0;
        const MEAN_ELEMENT = this.MEAN_ELEMENT !== null ? this.MEAN_ELEMENT.pack(builder) : 0;
        const SEGMENTS = this.SEGMENTS !== null ? this.SEGMENTS.pack(builder) : 0;
        const FIT = this.FIT !== null ? this.FIT.pack(builder) : 0;
        const EVENTS = PCF.createEventsVector(builder, builder.createObjectOffsetList(this.EVENTS));
        const MANEUVER_DETECTION = this.MANEUVER_DETECTION !== null ? this.MANEUVER_DETECTION.pack(builder) : 0;
        const REENTRY = this.REENTRY !== null ? this.REENTRY.pack(builder) : 0;
        const LAUNCH = this.LAUNCH !== null ? this.LAUNCH.pack(builder) : 0;
        const OUTPUT = this.OUTPUT !== null ? this.OUTPUT.pack(builder) : 0;
        PCF.startPCF(builder);
        PCF.addConfigurationId(builder, CONFIGURATION_ID);
        PCF.addProfile(builder, PROFILE);
        PCF.addTheory(builder, this.THEORY);
        PCF.addIntegrator(builder, INTEGRATOR);
        PCF.addForces(builder, FORCES);
        PCF.addMeanElement(builder, MEAN_ELEMENT);
        PCF.addSegments(builder, SEGMENTS);
        PCF.addFit(builder, FIT);
        PCF.addEvents(builder, EVENTS);
        PCF.addManeuverDetection(builder, MANEUVER_DETECTION);
        PCF.addReentry(builder, REENTRY);
        PCF.addLaunch(builder, LAUNCH);
        PCF.addOutput(builder, OUTPUT);
        return PCF.endPCF(builder);
    }
}
