export var timConversionStatus = /*#__PURE__*/ function(timConversionStatus) {
    timConversionStatus[timConversionStatus["OK"] = 0] = "OK";
    timConversionStatus[timConversionStatus["INVALID_INPUT"] = 1] = "INVALID_INPUT";
    timConversionStatus[timConversionStatus["UNSUPPORTED_TIME_SYSTEM"] = 2] = "UNSUPPORTED_TIME_SYSTEM";
    timConversionStatus[timConversionStatus["LEAP_SECOND_DATA_REQUIRED"] = 3] = "LEAP_SECOND_DATA_REQUIRED";
    timConversionStatus[timConversionStatus["EOP_DATA_REQUIRED"] = 4] = "EOP_DATA_REQUIRED";
    timConversionStatus[timConversionStatus["OUT_OF_RANGE"] = 5] = "OUT_OF_RANGE";
    return timConversionStatus;
}({});
